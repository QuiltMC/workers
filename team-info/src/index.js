import { App } from "octokit";

const QUERY = `
{
  organization(login: "QuiltMC") {
    teams(first: 100) {
      edges {
        node {
          members(first: 100, orderBy: {field: LOGIN, direction: ASC}) {
            edges {
              node {
                login
              }
            }
          }
          slug
        }
      }
    }
  }
}
`

export default {
  async fetch(request, env) {
    const app = new App({
        appId: env.APP_ID,
        privateKey: env.PRIVATE_KEY.replaceAll("\\n", "\n"),
    });
    const octokit = await app.getInstallationOctokit(36439621);

    const data = {}
    const response = await octokit.graphql(QUERY);

    for (const team of response.organization.teams.edges) {
      const slug = team.node.slug;

      data[slug] = team.node.members.edges.map((member) => member.node.login);
    }

    console.log(response.organization.teams.edges);

    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  }
}