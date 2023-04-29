import { OAuthApp } from "@octokit/oauth-app";
import { Octokit } from "@octokit/core";
import {Router, RouterRequest} from "@tsndr/cloudflare-worker-router";
import Mustache from "mustache";
import jwt from '@tsndr/cloudflare-worker-jwt'

// @ts-ignore
import electionHtml from '../public/election.html'
// @ts-ignore
import createElectionHtml from '../public/create-election.html'

export interface Env {
	ELECTIONS: DurableObjectNamespace;
	ELECTION_META: KVNamespace;

	CLIENT_ID: string;
	CLIENT_SECRET: string;
	JWT_SECRET: string;
}

export class ElectionDO {
	state: DurableObjectState;

	constructor(state: DurableObjectState) {
		this.state = state;
	}

	async fetch(request: Request): Promise<Response> {
		let url = new URL(request.url);

		if (url.pathname == "/set-urls") {
			await this.state.storage.put("unassigned", await request.text());
			return new Response("OK");
		}

		const userId = url.pathname.slice(1);
		let userUrl: string | undefined = await this.state.storage.get(userId);

		if (userUrl === undefined) {
			const allUnassigned = JSON.parse(await this.state.storage.get("unassigned") || "[]");
			userUrl = allUnassigned.pop();

			if (userUrl === undefined) {
				return new Response("No more URLs available", { status: 503 });
			}

			await this.state.storage.put("unassigned", JSON.stringify(allUnassigned));
			await this.state.storage.put(userId, userUrl);
		}

		return new Response(userUrl);
	}
}

interface AuthResult {
	userId: string;
	admin: boolean;
}

function parseCookies(request: RouterRequest): Record<string, string> {
	const cookieHeader = request.headers.get("Cookie") || "";
	const cookies: Record<string, string> = {};
	if (cookieHeader) {
		cookieHeader.split(";").forEach((cookie) => {
			const [key, value] = cookie.split("=");
			cookies[key.trim()] = (value || "").trim();
		});
	}
	return cookies;
}

async function checkAuth(request: RouterRequest, env: Env): Promise<AuthResult | false> {
	const cookies = parseCookies(request)
	if (!cookies.token) {
		return false
	}

	try {
		if (!await jwt.verify(cookies.token, env.JWT_SECRET)) {
			return false
		}
	} catch (e) {
		return false
	}
	const { payload } = jwt.decode(cookies.token)

	return {
		userId: payload.userId,
		admin: payload.admin
	}
}

const router = new Router<Env>()
router.cors({allowOrigin: "https://elections.quiltmc.org"})

router.get("/e/:election", async ({ req, res, env }) => {
	const electionMetaString = await env.ELECTION_META.get(req.params.election)

	if (!electionMetaString) {
		res.status = 404
		return
	}
	const electionMeta = JSON.parse(electionMetaString)

	if ((new Date()).toISOString() > electionMeta.closeTime) {
		res.body = Mustache.render(electionHtml, {
			name: electionMeta.name,
			description: electionMeta.description,
			voteInProgress: false
		})
	} else {
		const auth = await checkAuth(req, env)

		const app = new OAuthApp({
			clientId: env.CLIENT_ID,
			clientSecret: env.CLIENT_SECRET
		});

		if (!auth) {
			const { url } = app.getWebFlowAuthorizationUrl({
				state: "/e/" + req.params.election,
				redirectUrl: "https://elections.quiltmc.org/callback",
				allowSignup: false,
				scopes: ["read:org"]
			})

			res.body = Mustache.render(electionHtml, {
				name: electionMeta.name,
				description: electionMeta.description,
				voteInProgress: true,
				loginUrl: url,
			})
		} else {
			const electionId = env.ELECTIONS.idFromName(electionMeta.machineId);
			const election = await env.ELECTIONS.get(electionId);

			const response = await election.fetch("http://do/" + auth.userId);
			if (response.status === 503) {
				res.body = await response.text();
				res.status = 503;
				return
			}

			res.body = Mustache.render(electionHtml, {
				name: electionMeta.name,
				description: electionMeta.description,
				voteInProgress: true,
				voteLink: await response.text(),
			})
		}
	}
	res.headers.set("Content-Type", "text/html")
})

router.get("/create" , async ({ req, res, env }) => {
	const auth = await checkAuth(req, env)
	const context = {
		loggedIn: !!auth,
		admin: false,
		loginUrl: ""
	}
	if (auth) {
		context.admin = auth.admin
	} else {
		const app = new OAuthApp({
			clientId: env.CLIENT_ID,
			clientSecret: env.CLIENT_SECRET
		});

		const { url } = app.getWebFlowAuthorizationUrl({
			state: "/create",
			redirectUrl: "https://elections.quiltmc.org/callback",
			allowSignup: false,
			scopes: ["read:org"]
		})

		context.loginUrl = url
	}
	res.body = Mustache.render(createElectionHtml, context)
	res.headers.set("Content-Type", "text/html")
})

router.post("/create", async ({ req, res, env }) => {
	const auth = await checkAuth(req, env)
	if (!auth || !auth.admin) {
		res.status = 403
		res.body = "You are not an admin"
		return
	}

	const param = new URLSearchParams(req.body)
	const name = param.get("name")
	const description = param.get("description")
	const closeTime = param.get("closeTime")
	const urls = param.get("urls")?.split(",")

	if (!name || !description || !closeTime || !urls) {
		res.status = 400
		res.body = "Missing required parameters"
		return
	}

	const machineId = name.toLowerCase().replaceAll(" ", "-");
	const electionId = env.ELECTIONS.idFromName(machineId);
	const election = await env.ELECTIONS.get(electionId);
	const response = await election.fetch("http://do/set-urls", { body: JSON.stringify(urls), method: "POST" });
	if (response.status !== 200) {
		res.status = 500;
		res.body = await response.text();
		return
	}

	await env.ELECTION_META.put(machineId, JSON.stringify({
		name,
		description,
		closeTime,
		machineId,
	}));

	res.headers.set("Location", "/e/" + machineId)
	res.status = 302
})

router.get("/callback", async ({ req, res, env }) => {
	const app = new OAuthApp({
		clientId: env.CLIENT_ID,
		clientSecret: env.CLIENT_SECRET
	});

	const { code, state } = req.query
	const { authentication } = await app.createToken({ code, state })

	const octokit = new Octokit({ auth: authentication.token })
	const { data: user } = await octokit.request("GET /user")

	let membership: any
	try {
		const { data } = await octokit.request("GET /orgs/QuiltMC/memberships/" + user.login)
		membership = data
	} catch {
		res.status = 403
		res.body = "You are not a member of the QuiltMC organization"
		return
	}

	const token = await jwt.sign({
		userId: user.id,
		admin: membership.role === "admin"
	}, env.JWT_SECRET)

	res.headers.set("Set-Cookie", `token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`)
	res.headers.set("Location", state)
	res.status = 302
})

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext
	): Promise<Response> {
		return await router.handle(env, request)
	},
};
