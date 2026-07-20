# Remote access: Tailscale, HTTPS and Funnel

Testing this app properly means reaching it from a phone. That turns out to be
harder than serving a port on the LAN, because two of the features the project
exists to demonstrate — the service worker and biometric unlock — **refuse to
run without a secure context**.

!!! warning "A plain-HTTP LAN address silently breaks the demo"
    `http://192.168.1.x:8321` or `http://100.x.y.z:8321` will load the page and
    then quietly fail to register a service worker (so no offline mode) and
    refuse WebAuthn entirely (so no Touch ID). Browsers treat `localhost` as a
    secure context but never a bare LAN or tailnet IP. You need real HTTPS.

Tailscale solves this in two steps, and they are worth keeping distinct:

| | `tailscale serve` | `tailscale funnel` |
| --- | --- | --- |
| Reachable from | Devices on your tailnet | **The entire public internet** |
| HTTPS certificate | Let's Encrypt, automatic | Let's Encrypt, automatic |
| Requires an ACL grant | No | **Yes** — `funnel` node attribute |
| Ports | Any | 443, 8443, 10000 only |
| Right choice for | Testing on your own phone | Sharing with someone outside your tailnet |

**Use `serve` unless you actually need someone outside your tailnet to reach the
app.** It is strictly less exposure for the same result.

## Step by step: `tailscale serve` (tailnet only)

### 1. Bind the server

`serve` proxies to loopback, so the default bind is fine:

```bash
uv run lockbox serve --port 8321
```

Use `--host 0.0.0.0` only if you also want the raw tailnet IP to work. It is not
needed for `serve`, and it widens exposure.

### 2. Start the proxy

```bash
tailscale serve --bg 8321
```

Output names the MagicDNS host it is now serving:

```
Available within your tailnet:
https://your-machine.your-tailnet.ts.net/
|-- proxy http://127.0.0.1:8321
```

### 3. Verify

```bash
tailscale serve status
curl -s https://<your-host>.ts.net/api/info
```

The first request may take several seconds while the certificate is provisioned.
A timeout on the very first call is normal — retry before assuming failure.

Confirm the certificate is genuine, since that is the whole point:

```bash
echo | openssl s_client -connect <your-host>.ts.net:443 \
  -servername <your-host>.ts.net 2>/dev/null | openssl x509 -noout -issuer
# issuer=C=US, O=Let's Encrypt, CN=...
```

### 4. Open it on the phone

Any device signed into the same tailnet can now open
`https://<your-host>.ts.net`. Service workers install, and Touch ID / Face ID
enrolment works from the **Security** page.

### Stopping

```bash
tailscale serve --https=443 off
```

## Step by step: `tailscale funnel` (public internet)

!!! danger "Do not enable Funnel with `--auth none`"
    Funnel publishes the API to the whole internet. With authentication off,
    **anyone who finds the URL can read, write and delete every note** — and in
    the default plaintext sync mode the server holds readable data by design.
    Funnel URLs follow a predictable `machine.tailnet.ts.net` pattern and get
    scanned. Always pair Funnel with `--auth token`.

### 1. Grant the `funnel` node attribute

This is the step that actually gates Funnel, and the one most likely to be
missing. `serve` needs no ACL grant, so a tailnet can happily serve for months
without it.

Open the [policy file](https://login.tailscale.com/admin/acls/file) and add:

```json
{
  "nodeAttrs": [
    {
      "target": ["autogroup:member"],
      "attr":   ["funnel"]
    }
  ]
}
```

Newer tailnets ship this by default. Older ones, or any tailnet with a
customised ACL, will not have it.

### 2. Confirm the capability arrived

```bash
tailscale status --json | grep -i funnel
```

You want to see both of these:

```
"funnel"
"https://tailscale.com/cap/funnel-ports?ports=443,8443,10000"
```

!!! note "A misleading error message"
    Without that attribute the CLI reports:

    ```
    Funnel is not available on the Starter plan.
    ```

    This is wrong, or at least badly worded — Tailscale's documentation states
    Funnel is available on **all plans**, and adding the `nodeAttrs` grant above
    makes it work on a Starter tailnet immediately. If you hit that message,
    check the ACL before believing the plan is the problem. Checking `CapMap`
    tells you the truth: `https` present but `funnel` absent means an ACL issue,
    not a billing one.

### 3. Start the server with authentication

```bash
uv run lockbox serve --port 8321 --auth token
```

It prints a freshly generated token:

```
Auth: token required on /api/*
  token: <a fresh 43-character random string>
```

Pass `--token <value>` to pin your own. Do not reuse a token from a tutorial or
a chat log.

### 4. Enable Funnel

```bash
tailscale funnel --bg 8321
tailscale funnel status
```

```
# Funnel on:
#     - https://your-machine.your-tailnet.ts.net
```

### 5. Prove the gate holds

Do this from outside, before trusting it:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<host>.ts.net/api/plain-notes
# 401

curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <token>" https://<host>.ts.net/api/info
# 200
```

### 6. Enter the token in the app

Open the app, sign in, then **Security → Server access token**. Paste and press
*Save and test*. The badge reports `authorised`, `rejected` or `offline`.

### Stopping

```bash
tailscale funnel reset          # turn Funnel off
tailscale funnel --https=443 off
```

## Changing hostname starts you over — by design

The single most confusing thing about moving from `localhost` to a Tailscale
hostname: **your vault, your users and your biometric enrolment do not come
with you.**

Nothing is broken. Two separate browser security rules are doing their job:

| Thing | Scoped to | Consequence of changing host |
| --- | --- | --- |
| IndexedDB (vaults, notes, outbox) | **Origin** | `http://127.0.0.1:8321` and `https://host.ts.net` have entirely separate databases |
| WebAuthn credential | **RP ID** (the domain) | A Touch ID credential enrolled on `127.0.0.1` cannot be asserted on `host.ts.net` |

So on a new hostname you will see the **Add a user** screen even though you
already created one locally, and biometric unlock has to be enrolled again.

!!! tip "This is the multi-device story, not an obstacle"
    It is the same demonstration as opening the app in a private window: a new
    origin behaves exactly like a new device. Create a user, sign in, then
    **Pull from server** — the notes arrive, re-encrypted under the new user's
    key. Shared data on the server, separate keys on every client. That is the
    entire architecture, visible in about thirty seconds.

Pick one hostname and stay on it if you want continuity. Using the Tailscale
name for everything — including on the laptop — avoids the surprise entirely,
and has the side benefit that every feature (service worker, WebAuthn) behaves
the same way there as on a phone.

## What stays public even with auth on

Only `/api/*` is gated. The app shell (`/`, `/assets/*`) and `/sw.js` are served
without credentials, deliberately:

- they contain no secrets — the JavaScript is the same for every user, and the
  encryption key never appears in it;
- gating them would mean authenticating **before** the service worker could
  install, which breaks offline loading, the feature this project is about.

Public SPA plus authenticated API is the conventional split. The practical
consequence is that anyone with the Funnel URL can load the interface. They
simply cannot read or write anything through it.

## Authentication modes

| Mode | Command | Use when |
| --- | --- | --- |
| `none` (default) | `lockbox serve` | Bound to `127.0.0.1` only |
| `token` | `lockbox serve --auth token` | Anything reachable by another machine |

Binding beyond loopback with `--auth none` prints a red warning, because that
combination is the one that turns a learning project into an open data endpoint.

!!! info "What token auth is not"
    A single shared token is not per-user authentication. Everyone holding it is
    equally trusted, so the `author` field on a note remains self-declared and
    forgeable by any client. A real DHIS2 integration delegates identity to the
    platform: the user authenticates against DHIS2, and the server derives the
    author from that session instead of believing the client. See
    [DHIS2 Context](../context/dhis2.md).
