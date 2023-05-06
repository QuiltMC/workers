import { S3Client, PutObjectCommand, ListObjectsCommand } from "@aws-sdk/client-s3";

export interface Env {
	UPLOAD_QUEUE: Queue;
	INDEX_QUEUE: Queue;
	INDEX_KV: KVNamespace;

	B2_ENDPOINT: string;
	B2_REGION: string;
	B2_BUCKET: string;
	B2_KEY: string;
	B2_SECRET: string;

	CLOUDFLARE_ZONE: string;
	CLOUDFLARE_TOKEN: string;

	ORIGIN: string;
	ALLOWED_REPOS: string;
	AUTHORIZED_USERS: string;
}

interface User {
	username: string;
	password: string;
	scope: string;
}

const head = `
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<title>Quilt Maven</title>
	<link rel="stylesheet" href="/styles.css">
</head>
<body>`;

const tail = `
</body>
</html>`;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method != "PUT") {
			return new Response("Bad method.", { status: 405 });
		}

		const url = new URL(request.url);
		const path = url.pathname.substring(1); // Remove leading slash
		const repo_directory = "repository/";

		if (!path.startsWith(repo_directory)) {
			return new Response("Trying to push outside of repository.", { status: 401 })
		}

		const repository = path.substring(repo_directory.length, path.indexOf("/", repo_directory.length));
		const allowed_repos: string[] = JSON.parse(env.ALLOWED_REPOS);

		if (!allowed_repos.includes(repository)) {
			return new Response(`${repository} is not an allowed repository.`, { status: 401 });
		}

		if (!await authorize(request, repository, env)) {
			return new Response("Not authorized.", { status: 401 });
		}

		if (request.body == null) {
			return new Response("No body provided.", { status: 400 });
		}

		const command = new PutObjectCommand({ Body: request.body, Bucket: env.B2_BUCKET, Key: path.replaceAll("+", " "), ContentType: await getContentType(request.url) });
		await getS3(env).then(s3 => s3.send(command));

		ctx.waitUntil(env.UPLOAD_QUEUE.send(path));

		return new Response("Upload successful.");
	},

	async queue(batch: MessageBatch<string>, env: Env, ctx: ExecutionContext) {
		switch(batch.queue) {
			case "maven-uploads":
				ctx.waitUntil(queue_upload(batch, env, ctx));
				break;
			case "maven-to-index":
				ctx.waitUntil(queue_index(batch, env, ctx));
				break;
		}
	}
};

async function queue_upload(batch: MessageBatch<string>, env: Env, ctx: ExecutionContext) {
	const files: string[] = [];
	const directories = new Set<string>;

	for (const message of batch.messages) {
		const path = message.body;
		files.push(path);
		const directory = path.slice(0, path.lastIndexOf("/") + 1);

		if (!directory.includes(directory)) {
			env.INDEX_QUEUE.send(directory);
			directories.add(directory);
		}
	}

	ctx.waitUntil(purge(files, env, ctx));
}

async function queue_index(batch: MessageBatch<string>, env: Env, ctx: ExecutionContext) {
	for (const message of batch.messages) {
		ctx.waitUntil(indexRecursively(message.body, env, ctx));
	}
}

async function getS3(env: Env): Promise<S3Client> {
	return new S3Client({ endpoint: env.B2_ENDPOINT, region: env.B2_REGION, credentials: { accessKeyId: env.B2_KEY, secretAccessKey: env.B2_SECRET } });
}

async function indexRecursively(directory: string, env: Env, ctx: ExecutionContext) {
	ctx.waitUntil(index(directory, env, ctx));

	if (await env.INDEX_KV.get(directory) === null) {
		const name = directory.slice(0, directory.lastIndexOf("/"));
		if (name.includes("/")) {
			const parent = name.slice(0, name.lastIndexOf("/") + 1);
			ctx.waitUntil(indexRecursively(parent, env, ctx));
		}
		ctx.waitUntil(env.INDEX_KV.put(directory, "1"));
	}
}

async function index(path: string, env: Env, ctx: ExecutionContext) {
	const s3 = await getS3(env);
	const links = ["<a href='../'>../</a>"];

	const command = new ListObjectsCommand({ Bucket: env.B2_BUCKET, Prefix: path.replaceAll("+", " "), Delimiter: "/" });
	const response = await s3.send(command);

	if (response.CommonPrefixes !== undefined) {
		for (const dir of response.CommonPrefixes) {
			const name = dir.Prefix?.substring(path.length).replaceAll(" ", "+");
			links.push(`<p><a href="${name}">${name}</a></p>`);
		}
	}

	if (response.Contents !== undefined) {
		for (const file of response.Contents) {
			const name = file.Key?.substring(path.length).replaceAll(" ", "+");
			links.push(`<p><a href="${name}">${name}</a></p>`);
		}
	}

	const body = head + `<h1>${path}</h1>` + links.join("") + tail;
	const put = new PutObjectCommand({ Body: body, Bucket: env.B2_BUCKET, Key: path.replaceAll("+", " "), ContentType: "text/html" });
	ctx.waitUntil(s3.send(put));

	ctx.waitUntil(purge([env.ORIGIN + path], env, ctx));
}

async function authorize(request: Request, repository: string, env: Env): Promise<boolean> {
	const authorization = request.headers.get("authorization");

	if (authorization == null || !authorization.startsWith("Basic")) {
		return false;
	}

	const [username, password] = atob(authorization.substring(6)).split(":");
	const table: User[] = JSON.parse(env.AUTHORIZED_USERS);

	for (const user of table) {
		if (user.username === username && user.password === await hash(password) && (user.scope === "*" || user.scope === repository)) {
			return true;
		}
	}

	return false;
}

async function hash(password: string): Promise<string> {
	const data = new TextEncoder().encode(password);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, "0")).join("");
}

async function getContentType(url: string): Promise<string> {
	const path = new URL(url).pathname;

	if (path.endsWith(".jar")) {
		return "application/java-archive";
	} else if (path.endsWith(".xml") || path.endsWith(".pom")) {
		return "application/xml";
	} else if (path.endsWith(".json") || path.endsWith(".module")) {
		return "application/json";
	} else {
		return "application/octet-stream";
	}
}

async function purge(paths: string[], env: Env, ctx: ExecutionContext) {
	const FILES_PER_REQUEST = 30;
	const requests = paths.length / FILES_PER_REQUEST + 1;

	for (let i = 0; i < requests; i++) {
		const options = {
			method: "POST",
			headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.CLOUDFLARE_TOKEN}` },
			body: `{"files":${JSON.stringify(paths.slice(i * FILES_PER_REQUEST, (i + 1) * FILES_PER_REQUEST))}}`
		};

		ctx.waitUntil(fetch(`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE}/purge_cache`, options));
	}
}
