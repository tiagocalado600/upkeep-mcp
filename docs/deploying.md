# Deploying the HTTP instance

The server speaks two transports. `stdio` is what a local MCP client starts on
your own machine, and it is the one you want unless you are publishing a demo.
This page is about the other one.

## What is different about the public instance

A stranger holding the keyboard is not the same as you holding it, so the HTTP
entrypoint is not the stdio entrypoint with a socket bolted on:

- **It contacts only public addresses, on three ports.** 443 over HTTPS; 80 over
  plain HTTP, which is the only way to answer `uptime_check`'s question about
  whether HTTP upgrades; and 53 to the nameservers a domain itself publishes,
  which is the only way to answer whether they agree about it. That third one is
  not a destination a caller chooses — it is whatever the target domain's NS
  records name, put through the same guard as everything else. Any other port is
  refused: an endpoint that connects wherever a stranger asks is a port scanner
  wearing this project's name. Anything resolving to loopback, a private range or the
  link-local address where cloud metadata services live is refused with an
  explanation.
  [`docs/adr/0012`](adr/0012-public-target-guard.md) covers why, and what that
  guard still does not close.
- **It admits traffic through a token bucket**: 60 requests a minute per caller
  with a burst of 20, at most 2 requests in flight per caller, and 8 in flight
  across everyone. A refusal is an answer with a reason, not a dropped
  connection. A request's body is read before it takes one of those 8 slots,
  and a client has 10 seconds to send its headers and 15 to send the whole
  request (Node's defaults are 60 and 300), so a caller dribbling a body holds a
  socket briefly and a slot never.
- **A caller is the last address in `X-Forwarded-For` — only when told to
  read it.** Without a flag the server ignores the header and keys callers on
  the socket address, because with nothing in front of it the header is
  whatever the caller sent: a plain `docker run` of the published image that
  trusted it gave a fresh bucket to every request with a new made-up address.
  The Cloud Run deploy below passes `--forwarded-for-hops 0`. Every proxy
  appends to that header, so a caller can write anything to the left of what
  the platform adds and nothing to the right of it. Keying on the first entry,
  as an earlier version did, gave every request with a made-up header a fresh
  bucket. Google does not document how Cloud Run's front end fills the header
  for a `run.app` URL — the
  [container contract](https://docs.cloud.google.com/run/docs/container-contract)
  is silent on it — and the last-entry rule rests on
  [observed behaviour](https://discuss.google.dev/t/cloud-run-which-client-ip-can-i-safely-use-for-rate-limiting/409611),
  which is why confirming it is a step of every deploy below. Behind an external
  Application Load Balancer the header
  [ends `CLIENT_IP,LOAD_BALANCER_IP`](https://docs.cloud.google.com/load-balancing/docs/https),
  and the flag becomes `--forwarded-for-hops 1`.
- **One process serves every visitor, and it keeps no run history for any of
  them.** The instance refuses to read a portfolio file, so every caller passes
  sites inline, and an inline portfolio keeps no history at all: nothing tells
  one caller's sites from another's, and before `0.7.0` a shared store showed one
  caller the sites, findings and run dates of whoever called before. No baseline
  can be saved under a name either. A comparison here is kept by the caller:
  `includeSnapshot` returns the run, and `baselineSnapshot` passes it back, which
  is also how a local install compares an inline portfolio.
- **It reads no environment variables and holds no secrets.** The port comes
  from `--port`. There is nothing to configure and nothing to leak.

## Locally

```bash
npm run build
npm run start:http -- --port 8080
```

Then point an MCP client at `http://127.0.0.1:8080/mcp`. Opening the root in a
browser gives a plain-text page saying what the service is.

Note that the guard will refuse to check anything on your own network, which
includes `localhost`. That is the entrypoint working; use the stdio server for
local targets.

## On Google Cloud Run

Cloud Run was chosen because it runs an ordinary container: `node:dns`'s
resolver and raw TLS sockets both work, which they do not on edge runtimes.
[`docs/adr/0015`](adr/0015-cloud-run-as-the-deployment-target.md) records the
comparison and what would reopen it.

Its free tier is perpetual and generous for a demo: 2 million requests,
180,000 vCPU-seconds and 360,000 GiB-seconds a month.

### Grant this before the first deploy

`--source .` builds through Cloud Build, which since mid-2024 runs as the
compute default service account rather than the old Cloud Build one. Without
`roles/run.builder` on it, the first deploy fails with

```
ERROR: (gcloud.run.deploy) NOT_FOUND: Build failed.
The service has encountered an internal error. Please try again later.
```

which is a permission error wearing a platform error's clothes. Grant the role
and give it a couple of minutes to propagate.

### The deploy

```bash
gcloud run deploy upkeep-mcp \
  --source . \
  --region europe-west1 \
  --execution-environment gen2 \
  --allow-unauthenticated \
  --port 8080 \
  --command node \
  --args=dist/http.js,--port,8080,--forwarded-for-hops,0 \
  --memory 1Gi \
  --max-instances 2 \
  --concurrency 20 \
  --timeout 300
```

`--command` and `--args` replace the image's `CMD` with the same command plus
`--forwarded-for-hops 0`, which tells the server Google's front end appends the
caller's address as the last `X-Forwarded-For` entry. The image's own `CMD`
leaves it out on purpose, so the image run anywhere else keys callers on the
socket address until someone says what is in front of it. Cloud Run keeps both
settings for later deploys. Without them, every caller of the hosted instance
shares the front end's one bucket.

`--max-instances 2` is a cost ceiling, not a capacity target: the inbound
limiter already caps what one instance will take, and this caps how many
instances a determined caller can conjure.

`--timeout 300` is sized from the slowest thing this server does. Measured on a
home connection, over the same twenty public sites, one process per run so no
cache is warm:

| Checks                          | Time         |
| ------------------------------- | ------------ |
| domain, SSL, uptime             | 8.4s         |
| + `accessibility_audit`         | 12.6s        |
| `accessibility_audit` alone     | 8.5s         |
| + `seo_audit` (25 links a site) | 59.2s        |
| all five                        | 55.2s, 55.7s |

**Link checking is the cost, and the browser is not.** That is the opposite of
what this section assumed before anyone measured it. `seo_audit` makes one
request per internal link, paced at half a second per host, and it is the whole
of the difference between eight seconds and a minute. Twenty axe runs cost about
eight seconds between them — two browsers at a time, each launch and audit under
a second on small static pages — and they overlap with everything else, which is
why running all five checks is not slower than running `seo_audit` alone. A site
that does not answer adds its own deadline rather than its own duration: one host
refusing connections cost 13 seconds of the run it was in.

That leaves real headroom at 300s for the measured case, and the platform default
is also 300s. **The worst case is a different number and it does not fit.** Each
check carries its own deadline, and the arithmetic of twenty sites all hitting
theirs is what a timeout has to survive: `accessibility_audit` allows 45 seconds
a site and runs two at a time, so twenty pages that all hang cost 450 seconds —
past 300, and the request is cut off before the report exists. A portfolio much
past twenty sites, a client on a slower link than this was measured on, or a run
where several sites are genuinely down, needs a larger `--timeout` or belongs on
the stdio server, which has no request deadline at all.

A European region because the egress argument that once pointed at the United
States does not survive arithmetic. Internet egress is priced by **destination**
continent, at about $0.12/GiB either way, so a US region buys nothing on rate.
The only difference is a free first gibibyte that exists for North American
source regions — and this server pulls rather than pushes, so the bytes it
downloads are ingress and free, while a whole `portfolio_report` goes back as
about 5.6 KB. At the traffic a demo sees, that free gibibyte is worth roughly
half a cent a month. Latency to European targets is worth more.

`europe-southwest1` (Madrid) is nearer still, and it is a Tier 1 region, so it
costs the same to run. What it does not have is Cloud Run **domain mapping**,
which `europe-west1` does. That only matters the day this server answers on a
name of its own instead of a `run.app` URL — but on that day Madrid means
moving the service or paying for a load balancer in front of it, and the
latency it saves is a few milliseconds on a check that already budgets ten
seconds. Hence `europe-west1` in the command above.

### Outbound UDP does not leave this platform, and one feature is built around it

`domain_check` resolves through `node:dns`'s `Resolver`, which sends UDP to
whatever `/etc/resolv.conf` names. On Cloud Run that is the metadata resolver at
`169.254.169.254`, and it works — the platform depends on the same path.

**UDP to arbitrary internet hosts does not leave Cloud Run.** Nothing here sends
any, and `dns.ts` still never calls `setServers`. This was written down as the
trap waiting for whoever added the obvious next feature — querying a zone's
authoritative nameservers directly — because those queries would all fail here.
At the time `optional()` turned each failure into an empty record set, so the
symptom would have been a healthy client domain reported as publishing no CAA,
no MX and no NS. A failed query is now named in `dns.unanswered` and reported as
`unknown` rather than as an absence, but every query failing would still be an
outage of the check.

That feature was added in v0.6.0 and it takes the other road: **TCP port 53**,
with the DNS message built and read in `src/lib/dns-wire.ts` rather than by
`node:dns`, which offers no TCP-only mode and no way to see the `AA` flag.
TCP egress leaves Cloud Run normally.
[`docs/adr/0020`](adr/0020-asking-the-nameservers-over-tcp.md) records the
decision, the port it opens, and how a nameserver that merely refuses TCP is
kept from being reported as a broken one.

Verified against the deployed instance, not only locally — which is what this
section always asked for. The way to do that without putting unreleased code on
the public URL is a tagged revision carrying no traffic:

```bash
gcloud run deploy upkeep-mcp --source . --region europe-west1 \
  --execution-environment gen2 --allow-unauthenticated --port 8080 \
  --command node --args=dist/http.js,--port,8080,--forwarded-for-hops,0 \
  --memory 1Gi --max-instances 2 --concurrency 20 --timeout 300 \
  --tag verify --no-traffic
```

which answers on `https://verify---<service>.run.app` while the public URL keeps
serving what it served.

**Confirm the rate limiter keys on the caller, not on the platform**, on that
tagged revision, before it takes traffic. The per-caller limits rest on the
last `X-Forwarded-For` entry being the address Cloud Run's front end accepted
the connection from, and Google does not document that. Two failures are
possible and they look opposite: if the caller's own header wins, the limit is
decorative; if the front end appends an address of its own, every visitor
shares one bucket. Both show in thirty requests:

```bash
URL=https://verify---<service>.run.app/mcp
for i in $(seq 1 30); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "x-forwarded-for: 10.0.$i.1" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
done | sort | uniq -c
```

Expect about twenty `200` and the rest `429`: the made-up header changed
nothing. Thirty `200` means the caller's header is being keyed on. Then run the
same loop from a second network — a phone's hotspot will do — while the first
is still refused: it should get `200`. A `429` there means every caller shares
one key: the revision is missing `--forwarded-for-hops`, or its value is wrong
for this platform. Remove the tag when the verification is done, or the URL
stays reachable:

```bash
gcloud run services update-traffic upkeep-mcp --region europe-west1 --remove-tags verify
```

**`--no-traffic` leaves the service pinned, and removing the tag does not
unpin it.** A service deployed without it serves whatever revision is newest;
one `--no-traffic` deploy replaces that with an explicit revision, and every
later `gcloud run deploy` then builds a revision that receives nothing. The
symptom is a deploy reporting success while the public URL keeps serving the
version before it — which is exactly what happened releasing v0.6.0. Put it back
afterwards:

```bash
gcloud run services update-traffic upkeep-mcp --region europe-west1 --to-latest
```

On revision `upkeep-mcp-00010-gur` the answers were identical to the local ones,
down to `sapo.pt`'s four nameservers refusing TCP in both places — which is what
established that the refusals are theirs and not the platform's.

**The platform resolver already declines one record type: CAA.** Measured on the
first deployed instance — A, AAAA, NS, MX and TXT all correct, CAA empty for two
domains that publish it. So `ports.ts` asks DNS-over-HTTPS for CAA whenever the
resolver returns none, and a hosted instance answers what a local one does. The
cost is one extra request for a domain that genuinely has no CAA, which is most
of them; a domain that has one is answered locally and never reaches the
fallback. It is paced by the same per-host limiter as every other third-party
call, and it runs after the record lookup rather than inside it, so a slow
endpoint costs a CAA answer and never the whole domain check.

### The first thing to check once it is live

No provider documents outbound UDP behaviour clearly, so run the check rather
than trusting the reasoning. Point a client at the new instance and call
`domain_check` on a domain known to publish a full set of records:

```json
{ "domain": "google.com" }
```

A, AAAA, NS, MX, TXT and CAA should all come back populated, with
`dns.unanswered` empty. A record set listed there, or reported as
`dns_records_not_established`, means DNS is failing on the platform for that
record type. An empty set with nothing unanswered means the resolver answered
"none", which a platform resolver that declines a type does too.

This is not hypothetical: run on the first deployment, it caught exactly that,
for CAA. Compare against the same call on a machine with an ordinary resolver;
a difference between the two is the finding.

### What only you can do

- Create the Google Cloud project and attach a billing account. A card is
  required even though the free tier costs nothing, and that is true of every
  provider worth using.
- **Set a budget alert.** No line of code can stop egress charges if the
  endpoint is abused, and the guard raises the cost of abuse rather than
  removing it.
- **Add a logs exclusion on the `_Default` sink.** Cloud Run writes a request
  log for every request and offers no way to turn that off from its own side;
  Cloud Logging charges $0.50/GiB past the first 50 GiB. It is the one runaway
  that neither `--max-instances` nor a spend cap contains, and every bot probing
  `/.env` writes a line. People have been billed an order of magnitude more for
  logging than for compute.
- Decide whether the URL goes in the README. A demo that has quietly stopped
  paying its own bill is worse than no demo, so the budget alert and the logs
  exclusion above come first. Both are in place for the instance in the README,
  which is worded as a URL that may be switched off, with `npx -y upkeep-mcp`
  named as the supported path.

## The demo runs `accessibility_audit` too

The image ships a browser — the Chromium headless shell, 196 MB, installed with
`--only-shell`. [`docs/adr/0016`](adr/0016-a-browser-in-the-published-image.md)
records why that reverses the container half of `0013`, and what it cost.

What made it safe to do is that every connection the browser opens goes through
the same target policy as the rest of the server. Before that, only the page's
own URL was checked and the browser fetched whatever the page embedded — which
was reachable by anyone running this entrypoint with a browser installed, not
only by a hosted instance.

Two layers do it. `blockRefused` in `src/lib/axe.ts` routes every request and
WebSocket the page makes and aborts what the policy refuses. Underneath it, the
browser is launched with a forward proxy on loopback (`src/lib/browser-proxy.ts`)
as its only way out: it resolves each name once, checks every address, and
connects to one it checked. That second layer is the one a page cannot route
around — a WebSocket opened from a worker never meets the first — and it is what
stops a name that rebinds to `169.254.169.254` between the check and the
connection. Service workers are blocked, and WebRTC may not send UDP outside the
proxy.

Two settings in the deploy command exist for the browser: `--memory 1Gi`,
because Chromium does not fit in 512Mi, and `--execution-environment gen2`,
because gen1's gVisor is where a browser is most likely to fail. Chromium
started on gen2 without `--no-sandbox`, so its own sandbox is intact and the
flag is deliberately absent.

## What this is not

It is a demo, not a service. It has no authentication, no availability promise
and no support. Anyone who wants to rely on these checks should run the stdio
server on their own machine, where none of the restrictions above apply.
