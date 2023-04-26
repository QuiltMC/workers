export default {
  async fetch(request, env) {
    return new Response("method not allowed", {status: 405});
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(process(env));
  },
}

const GRAPHQl_QUERY = `
{
  viewer {
    zones(filter: { zoneTag: $tag })
    {
      firewallEventsAdaptive(
        limit: 100
        orderBy: [ datetime_DESC ]
        filter: {
          datetime_gt: $datetimeStart
        }
      ) {
        action
        datetime
        ruleId
        host: clientRequestHTTPHost
        path: clientRequestPath
        asn: clientAsn
        country: clientCountryName
        ipclass: clientIPClass
        colo: edgeColoName
        userAgent
        ip: clientIP
      }
    }
  }
}
`

async function process(env) {
  const date = new Date()
  date.setHours(date.getHours() - 1)

  const resp = await fetch(
    "https://api.cloudflare.com/client/v4/graphql", 
    { 
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.CLOUDFLARE_TOKEN },
      method: "POST",
      body: JSON.stringify({
        query: GRAPHQl_QUERY,
        variables: {
          tag: env.ZONE_TAG,
          datetimeStart: date
        }
      })
    }
  );
  const body = await resp.json();
  console.log(body);
  const events = body.data.viewer.zones[0].firewallEventsAdaptive;
  
  for (const event of events.filter((e) => e.country !== "T1")) {
    const ipUint8 = new TextEncoder().encode(event.ip + env.FINGERPRINT_SALT);
    const hashBuffer = await crypto.subtle.digest('sha-256', ipUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const fingerprint = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    await fetch(
      env.DISCORD_WEBHOOK,
      {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({
          embeds: [{
            title: "Firewall event recorded",
            color: 0xF48120,
            timestamp: event.datetime,
            fields: [
              { name: "Action", value: event.action.replaceAll("_", " ") },
              { name: "Rule", value: event.ruleId },
              { name: "Host", value: event.host },
              { name: "Path", value: event.path },
              { name: "User Agent", value: event.userAgent },
              { name: "ASN", value: "AS" + event.asn },
              { name: "Country", value: event.country },
              { name: "Class", value: event.ipclass },
              { name: "Colo", value: event.colo },
            ],
            footer: { text: "Fingerprint: " + fingerprint.slice(0, 8) }
          }]
        })
      }
    );
  }
}