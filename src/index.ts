#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import { createNosanaClient, NosanaNetwork, validateJobDefinition, type JobDefinition, type NosanaClient } from '@nosana/kit';

type Network = 'mainnet' | 'devnet';

type CommonOptions = {
  apiKey?: string;
  network: Network;
  rpc?: string;
  json?: boolean;
};

type PostOptions = CommonOptions & {
  file?: string;
  market: string;
  timeout: string;
  wait?: boolean;
  host?: string;
};

type DeployCreateOptions = CommonOptions & {
  file?: string;
  name: string;
  market: string;
  timeout: string;
  replicas: string;
  strategy: 'SIMPLE' | 'SIMPLE-EXTEND' | 'SCHEDULED' | 'INFINITE';
  schedule?: string;
  rotationTime?: string;
  start?: boolean;
  confidential?: boolean;
};

type CreditJobResponse = {
  tx: string;
  job: string;
};

const apiBaseUrls: Record<Network, string> = {
  mainnet: 'https://dashboard.k8s.prd.nos.ci',
  devnet: 'https://dashboard.k8s.dev.nos.ci'
};

function getApiKey(options: CommonOptions): string {
  const apiKey = options.apiKey ?? process.env.NOSANA_API_KEY;
  if (!apiKey) {
    throw new Error('Missing API key. Pass --api-key or set NOSANA_API_KEY.');
  }
  return apiKey;
}

function createClient(options: CommonOptions): NosanaClient {
  const network = options.network === 'mainnet' ? NosanaNetwork.MAINNET : NosanaNetwork.DEVNET;
  const config: Parameters<typeof createNosanaClient>[1] = {
    api: {
      apiKey: getApiKey(options)
    }
  };
  if (options.rpc) {
    config.solana = { rpcEndpoint: options.rpc };
  }
  return createNosanaClient(network, config);
}

async function nosanaApi<T>(
  options: CommonOptions,
  method: 'GET' | 'POST',
  pathname: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${apiBaseUrls[options.network]}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${getApiKey(options)}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) as unknown : undefined;

  if (!response.ok) {
    const detail = typeof data === 'object' && data !== null ? JSON.stringify(data) : text;
    throw new Error(`Nosana API ${method} ${pathname} failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  return data as T;
}

function output(options: { json?: boolean }, value: unknown): void {
  if (options.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function readJobDefinition(file: string): JobDefinition {
  const fullPath = path.resolve(file);
  const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Job definition must be a JSON object: ${fullPath}`);
  }
  const validation = validateJobDefinition(parsed);
  if (!validation.success) {
    throw new Error(`Invalid job definition: ${JSON.stringify(validation.errors)}`);
  }
  return parsed as JobDefinition;
}

async function resolveMarketWithNetwork(network: Network, market: string): Promise<string> {
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(market)) {
    return market;
  }

  const response = await fetch(`${apiBaseUrls[network]}/api/markets/${encodeURIComponent(market)}`);
  if (!response.ok) {
    throw new Error(`Failed to resolve market "${market}": HTTP ${response.status}`);
  }
  const body = (await response.json()) as { address?: string };
  if (!body.address) {
    throw new Error(`Market "${market}" did not resolve to an address.`);
  }
  return body.address;
}

async function waitForJob(client: NosanaClient, jobAddress: string): Promise<unknown> {
  let lastState = '';

  while (true) {
    const job = await client.api.jobs.get(jobAddress);
    const state = String(job.state);
    if (state !== lastState) {
      lastState = state;
      console.error(`status: ${state}`);
    }

    if (state === 'COMPLETED' || state === 'STOPPED' || state === '2' || state === '3') {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

const program = new Command()
  .name('nosana-credits')
  .description('Post and manage Nosana jobs using account credits and a Nosana API key.')
  .version('0.1.0')
  .addOption(new Option('-n, --network <network>', 'Nosana network').choices(['mainnet', 'devnet']).default('mainnet'))
  .option('--api-key <key>', 'Nosana API key. Defaults to NOSANA_API_KEY.')
  .option('--rpc <url>', 'Optional Solana RPC URL for status reads.')
  .option('--json', 'Print machine-readable JSON.');

const deployCommand = program
  .command('deploy')
  .description('Create and manage dashboard deployments using account credits.');

deployCommand
  .command('create')
  .description('Create a Nosana dashboard deployment from a job definition.')
  .requiredOption('-f, --file <path>', 'Job definition JSON file.')
  .requiredOption('--name <name>', 'Deployment name.')
  .requiredOption('-m, --market <market>', 'Market slug or address.')
  .requiredOption('-t, --timeout <minutes>', 'Deployment timeout in minutes.')
  .option('--replicas <count>', 'Number of replicas.', '1')
  .addOption(new Option('--strategy <strategy>', 'Deployment strategy.').choices(['SIMPLE', 'SIMPLE-EXTEND', 'SCHEDULED', 'INFINITE']).default('SIMPLE'))
  .option('--schedule <cron>', 'Cron schedule for SCHEDULED strategy.')
  .option('--rotation-time <seconds>', 'Rotation time for INFINITE strategy.')
  .option('--confidential', 'Create a confidential deployment.')
  .option('--start', 'Start the deployment after creating it.')
  .action(async (commandOptions: Omit<DeployCreateOptions, keyof CommonOptions>) => {
    const options: DeployCreateOptions = { ...program.opts<CommonOptions>(), ...commandOptions };
    const client = createClient(options);
    const jobDefinition = readJobDefinition(options.file!);
    const market = await resolveMarketWithNetwork(options.network, options.market);
    const replicas = Number(options.replicas);
    const timeout = Number(options.timeout);

    if (!Number.isInteger(replicas) || replicas < 1) {
      throw new Error('--replicas must be an integer greater than 0.');
    }
    if (!Number.isFinite(timeout) || timeout < 1) {
      throw new Error('--timeout must be at least 1 minute.');
    }
    if (options.strategy === 'SCHEDULED' && !options.schedule) {
      throw new Error('--schedule is required for SCHEDULED deployments.');
    }

    const baseDeployment = {
      name: options.name,
      market,
      replicas,
      timeout,
      confidential: options.confidential,
      job_definition: jobDefinition
    };

    const deploymentBody =
      options.strategy === 'SCHEDULED'
        ? { ...baseDeployment, strategy: options.strategy, schedule: options.schedule! }
        : options.strategy === 'INFINITE'
          ? {
              ...baseDeployment,
              strategy: options.strategy,
              rotation_time: options.rotationTime ? Number(options.rotationTime) : undefined
            }
          : { ...baseDeployment, strategy: options.strategy };

    const deployment = await client.api.deployments.create(deploymentBody);
    if (options.start) {
      await deployment.start();
    }

    output(options, {
      id: deployment.id,
      name: deployment.name,
      status: deployment.status,
      market: deployment.market,
      replicas: deployment.replicas,
      timeout: deployment.timeout,
      strategy: deployment.strategy,
      activeJobs: deployment.active_jobs,
      dashboard: 'https://deploy.nosana.com'
    });
  });

deployCommand
  .command('list')
  .description('List dashboard deployments.')
  .option('--limit <count>', 'Page size: 10, 20, 50, or 100.', '10')
  .action(async (commandOptions: { limit: string }) => {
    const options = program.opts<CommonOptions>();
    const client = createClient(options);
    const limit = Number(commandOptions.limit) as 10 | 20 | 50 | 100;
    const result = await client.api.deployments.list({ limit });
    output(options, {
      totalItems: result.total_items,
      deployments: result.deployments.map((deployment) => ({
        id: deployment.id,
        name: deployment.name,
        status: deployment.status,
        activeJobs: deployment.active_jobs,
        market: deployment.market,
        updatedAt: deployment.updated_at
      }))
    });
  });

deployCommand
  .command('get')
  .description('Get a dashboard deployment.')
  .argument('<deployment>', 'Deployment id.')
  .action(async (deploymentId: string) => {
    const options = program.opts<CommonOptions>();
    const client = createClient(options);
    const deployment = await client.api.deployments.get(deploymentId);
    output(options, deployment);
  });

deployCommand
  .command('start')
  .description('Start a dashboard deployment.')
  .argument('<deployment>', 'Deployment id.')
  .action(async (deploymentId: string) => {
    const options = program.opts<CommonOptions>();
    const client = createClient(options);
    const deployment = await client.api.deployments.get(deploymentId);
    await deployment.start();
    output(options, { id: deployment.id, status: deployment.status, updatedAt: deployment.updated_at });
  });

deployCommand
  .command('stop')
  .description('Stop a dashboard deployment.')
  .argument('<deployment>', 'Deployment id.')
  .action(async (deploymentId: string) => {
    const options = program.opts<CommonOptions>();
    const client = createClient(options);
    const deployment = await client.api.deployments.get(deploymentId);
    await deployment.stop();
    output(options, { id: deployment.id, status: deployment.status, updatedAt: deployment.updated_at });
  });

program
  .command('balance')
  .description('Show account credit balance for the configured API key.')
  .action(async () => {
    const options = program.opts<CommonOptions>();
    output(options, await nosanaApi<unknown>(options, 'GET', '/api/credits/balance'));
  });

program
  .command('post')
  .description('Upload a job definition and post it using account credits.')
  .requiredOption('-f, --file <path>', 'Job definition JSON file.')
  .requiredOption('-m, --market <market>', 'Market slug or address.')
  .requiredOption('-t, --timeout <minutes>', 'Job timeout in minutes.')
  .option('--wait', 'Wait for the job to complete.')
  .option('--host <address>', 'Optional host/node address.')
  .action(async (commandOptions: Omit<PostOptions, keyof CommonOptions>) => {
    const options: PostOptions = { ...program.opts<CommonOptions>(), ...commandOptions };
    const client = createClient(options);
    const jobDefinition = readJobDefinition(options.file!);
    const ipfsHash = await client.ipfs.pin(jobDefinition);
    const market = await resolveMarketWithNetwork(options.network, options.market);
    const response = await nosanaApi<CreditJobResponse>(options, 'POST', '/api/jobs/list', {
      ipfsHash,
      timeout: Number(options.timeout),
      market,
      node: options.host
    });

    const result: Record<string, unknown> = {
      ipfsHash,
      job: response.job,
      tx: response.tx,
      market,
      explorer: `https://explore.nosana.com/jobs/${response.job}${options.network === 'devnet' ? '?network=devnet' : ''}`
    };

    if (options.wait) {
      result.finalJob = await waitForJob(client, response.job);
    }

    output(options, result);
  });

program
  .command('status')
  .description('Read job status.')
  .argument('<job>', 'Job address.')
  .action(async (job: string) => {
    const options = program.opts<CommonOptions>();
    const client = createClient(options);
    output(options, await client.api.jobs.get(job));
  });

program
  .command('stop')
  .description('Stop a queued or running credit-backed job.')
  .argument('<job>', 'Job address.')
  .action(async (job: string) => {
    const options = program.opts<CommonOptions>();
    output(options, await nosanaApi<unknown>(options, 'POST', `/api/jobs/${encodeURIComponent(job)}/stop`));
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
