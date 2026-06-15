# Nosana Credits CLI

Experimental CLI for submitting Nosana workloads through Nosana account credits with an API key.

The official `@nosana/cli` currently initializes a wallet and checks SOL/NOS balances before it uses the API job submission path. This CLI uses Nosana Kit's credit-backed API methods directly:

- `GET /api/credits/balance`
- `POST /api/jobs/list`
- `POST /api/jobs/{address}/stop`
- `POST /api/deployments/create`

## Install

```bash
npm install
npm run build
npm link
```

## Configure

Create a Nosana API key in your Nosana account and export it:

```bash
export NOSANA_API_KEY="your-api-key"
```

Do not commit API keys.

## Usage

Check account credits:

```bash
nosana-credits balance
```

Create a dashboard deployment:

```bash
nosana-credits deploy create \
  --file examples/ai-inference.json \
  --name my-ai-inference \
  --market nvidia-3060 \
  --timeout 10 \
  --replicas 1 \
  --strategy SIMPLE \
  --start
```

List deployments:

```bash
nosana-credits deploy list
```

Stop a deployment:

```bash
nosana-credits deploy stop <deployment-id>
```

Run the sample AI inference workload:

```bash
nosana-credits post \
  --file examples/ai-inference.json \
  --market nvidia-3060 \
  --timeout 10 \
  --wait
```

There is also a `examples/tinyllama.json` GPU model example, but container availability can vary by host.

Check a job:

```bash
nosana-credits status <job-address>
```

Stop a job:

```bash
nosana-credits stop <job-address>
```

## Jobs vs Deployments

`nosana-credits post` creates a direct one-off job through `/api/jobs/list`. It is useful for quick execution and appears in Nosana Explore under Jobs.

`nosana-credits deploy create` creates a dashboard deployment through `/api/deployments/create`. It has a name, status, replicas, strategy, revisions, and start/stop lifecycle, and appears in the Nosana Deploy dashboard.

## Notes

This project is intentionally small and credit-first. It still uses Solana reads through the SDK for job status, because Nosana jobs are represented on-chain. It does not require you to fund or pass a wallet for posting jobs with account credits.

The implementation follows Nosana's current API docs for credit-backed jobs, deployments, and credits:

- https://learn.nosana.com/api/jobs.html
- https://learn.nosana.com/api/create-deployments.html
- https://learn.nosana.com/api/credits.html

## License

MIT
