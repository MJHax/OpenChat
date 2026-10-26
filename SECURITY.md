# Security

## What OpenChat protects, and what it doesn't

OpenChat is built for one person, or a household, on a network they trust. **It has no login.** Anyone who can reach it can read every chat, change settings, and spend the OpenRouter credit of the key saved in it.

- By default it only listens on `127.0.0.1`, so no other machine can reach it.
- With `OPENCHAT_HOST=0.0.0.0` (and in the Docker image), every device on your network can. Only do this on a network you trust.
- **Never forward OpenChat's port to the internet.** To use it away from home, connect through a VPN such as Tailscale or WireGuard, or an SSH tunnel.

Even on your own machine, websites you visit can't use OpenChat through your browser:

- The API only answers on `localhost`, IP addresses, and names listed in `OPENCHAT_ALLOWED_HOSTS`, which blocks DNS rebinding.
- Requests from other sites and from sandboxed generated pages can't change data.

Your OpenRouter and Tavily keys are stored in the SQLite database, in plain text, on the machine running OpenChat. They are never sent to the browser in full.

## Reporting a vulnerability

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/MJHax/OpenChat/security/advisories/new) rather than in a public issue. I'll reply as soon as I can.
