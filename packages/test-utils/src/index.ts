import path from 'path';
import crypto from 'crypto';
import { ServerResponse } from 'http';
import fs from 'fs';
import express from 'express';
// @ts-ignore
import supertest from 'supertest-light';
// @ts-ignore
import { Keystone } from '@keystone-next/keystone-legacy';
import { initConfig, createSystem, createExpressServer } from '@keystone-next/keystone';
import { pushPrismaSchemaToDatabase } from '@keystone-next/keystone/migrations';
import {
  getCommittedArtifacts,
  writeCommittedArtifacts,
  requirePrismaClient,
  generateNodeModulesArtifacts,
} from '@keystone-next/keystone/artifacts';
import type { KeystoneConfig, BaseKeystone, KeystoneContext } from '@keystone-next/types';
import memoizeOne from 'memoize-one';

export type ProviderName = 'postgresql' | 'sqlite';

const hashPrismaSchema = memoizeOne(prismaSchema =>
  crypto.createHash('md5').update(prismaSchema).digest('hex')
);

const argGenerator = {
  postgresql: () => ({
    url: process.env.DATABASE_URL!,
    provider: 'postgresql' as const,
    getDbSchemaName: () => null as any,
    // Turn this on if you need verbose debug info
    enableLogging: false,
  }),
  sqlite: () => ({
    url: process.env.DATABASE_URL!,
    provider: 'sqlite' as const,
    // Turn this on if you need verbose debug info
    enableLogging: false,
  }),
};

// Users should use testConfig({ ... }) in place of config({ ... }) when setting up
// their system for test. We explicitly don't allow them to control the 'db' or 'ui'
// properties as we're going to set that up as part of setupFromConfig.
type TestKeystoneConfig = Omit<KeystoneConfig, 'db' | 'ui'>;
export const testConfig = (config: TestKeystoneConfig) => config;

const alreadyGeneratedProjects = new Set<string>();

async function setupFromConfig({
  provider,
  config: _config,
}: {
  provider: ProviderName;
  config: TestKeystoneConfig;
}) {
  const adapterArgs = await argGenerator[provider]();
  const config = initConfig({
    ..._config,
    db: adapterArgs,
    ui: { isDisabled: true },
  });

  const prismaClient = await (async () => {
    const { keystone, graphQLSchema } = createSystem(config);
    const artifacts = await getCommittedArtifacts(graphQLSchema, keystone);
    const hash = hashPrismaSchema(artifacts.prisma);
    if (provider === 'postgresql') {
      config.db.url = `${config.db.url}?schema=${hash.toString()}`;
    }
    const cwd = path.resolve('.api-test-prisma-clients', hash);
    if (!alreadyGeneratedProjects.has(hash)) {
      alreadyGeneratedProjects.add(hash);
      fs.mkdirSync(cwd, { recursive: true });
      await writeCommittedArtifacts(artifacts, cwd);
      await generateNodeModulesArtifacts(graphQLSchema, keystone, config, cwd);
    }
    await pushPrismaSchemaToDatabase(
      config.db.url,
      artifacts.prisma,
      path.join(cwd, 'schema.prisma'),
      true
    );
    return requirePrismaClient(cwd);
  })();

  const { keystone, createContext, graphQLSchema } = createSystem(config, prismaClient);

  const app = await createExpressServer(config, graphQLSchema, createContext, true, '', false);

  return { keystone, context: createContext().sudo(), app };
}

function networkedGraphqlRequest({
  app,
  query,
  variables = undefined,
  headers = {},
  expectedStatusCode = 200,
  operationName,
}: {
  app: express.Application;
  query: string;
  variables?: Record<string, any>;
  headers?: Record<string, any>;
  expectedStatusCode?: number;
  operationName?: string;
}) {
  const request = supertest(app).set('Accept', 'application/json');

  Object.entries(headers).forEach(([key, value]) => request.set(key, value));

  return request
    .post('/api/graphql', { query, variables, operationName })
    .then((res: ServerResponse & { text: string }) => {
      expect(res.statusCode).toBe(expectedStatusCode);
      return { ...JSON.parse(res.text), res };
    })
    .catch((error: Error) => ({
      errors: [error],
    }));
}

type Setup = { keystone: BaseKeystone; context: KeystoneContext; app: express.Application };

function _keystoneRunner(provider: ProviderName, tearDownFunction: () => Promise<void> | void) {
  return function (
    setupKeystoneFn: (provider: ProviderName) => Promise<Setup>,
    testFn?: (setup: Setup) => Promise<void>
  ) {
    return async function () {
      if (!testFn) {
        // If a testFn is not defined then we just need
        // to excute setup and tear down in isolation.
        try {
          await setupKeystoneFn(provider);
        } catch (error) {
          await tearDownFunction();
          throw error;
        }
        return;
      }
      const setup = await setupKeystoneFn(provider);
      const { keystone } = setup;
      await keystone.connect();

      try {
        await testFn(setup);
      } finally {
        await keystone.disconnect();
        await tearDownFunction();
      }
    };
  };
}

function _before(provider: ProviderName) {
  return async function (
    setupKeystone: (
      provider: ProviderName
    ) => Promise<{ keystone: Keystone<string>; app: any; context: any }>
  ) {
    const { keystone, context, app } = await setupKeystone(provider);
    await keystone.connect();
    return { keystone, context, app };
  };
}

function _after(tearDownFunction: () => Promise<void> | void) {
  return async function (keystone: Keystone<string>) {
    await keystone.disconnect();
    await tearDownFunction();
  };
}

function multiAdapterRunners(only = process.env.TEST_ADAPTER) {
  return [
    {
      runner: _keystoneRunner('postgresql', () => {}),
      provider: 'postgresql' as const,
      before: _before('postgresql'),
      after: _after(() => {}),
    },
    {
      runner: _keystoneRunner('sqlite', () => {}),
      provider: 'sqlite' as const,
      before: _before('sqlite'),
      after: _after(() => {}),
    },
  ].filter(a => typeof only === 'undefined' || a.provider === only);
}

export { setupFromConfig, multiAdapterRunners, networkedGraphqlRequest };
