import path from 'path';
import express from 'express';
import { generateAdminUI } from '@keystone-next/admin-ui/system';
import { devMigrations, pushPrismaSchemaToDatabase } from '../../lib/migrations';
import { createSystem } from '../../lib/createSystem';
import { initConfig } from '../../lib/initConfig';
import { requireSource } from '../../lib/requireSource';
import { createExpressServer } from '../../lib/createExpressServer';
import {
  generateCommittedArtifacts,
  generateNodeModulesArtifacts,
  getSchemaPaths,
  requirePrismaClient,
} from '../../artifacts';
import { getAdminPath, getConfigPath } from '../utils';

// TODO: Don't generate or start an Admin UI if it isn't configured!!
const devLoadingHTMLFilepath = path.join(
  path.dirname(require.resolve('@keystone-next/keystone/package.json')),
  'src',
  'static',
  'dev-loading.html'
);

export const dev = async (cwd: string, shouldDropDatabase: boolean) => {
  console.log('✨ Starting Keystone');

  const server = express();
  let expressServer: null | ReturnType<typeof express> = null;

  const config = initConfig(requireSource(getConfigPath(cwd)).default);
  const initKeystone = async () => {
    {
      const { keystone, graphQLSchema } = createSystem(config);

      console.log('✨ Generating GraphQL and Prisma schemas');
      const prismaSchema = (await generateCommittedArtifacts(graphQLSchema, keystone, cwd)).prisma;
      await generateNodeModulesArtifacts(graphQLSchema, keystone, config, cwd);

      if (config.db.useMigrations) {
        await devMigrations(
          config.db.url,
          prismaSchema,
          getSchemaPaths(cwd).prisma,
          shouldDropDatabase
        );
      } else {
        await pushPrismaSchemaToDatabase(
          config.db.url,
          prismaSchema,
          getSchemaPaths(cwd).prisma,
          shouldDropDatabase
        );
      }
    }

    const prismaClient = requirePrismaClient(cwd);

    const { keystone, graphQLSchema, createContext } = createSystem(config, prismaClient);

    console.log('✨ Connecting to the database');
    await keystone.connect({ context: createContext().sudo() });

    if (config.ui?.isDisabled) {
      console.log('✨ Skipping Admin UI code generation');
    } else {
      console.log('✨ Generating Admin UI code');
      await generateAdminUI(config, graphQLSchema, keystone, getAdminPath(cwd));
    }

    console.log('✨ Creating server');
    expressServer = await createExpressServer(
      config,
      graphQLSchema,
      createContext,
      true,
      getAdminPath(cwd)
    );
    console.log(`👋 Admin UI and graphQL API ready`);
  };

  server.use('/__keystone_dev_status', (req, res) => {
    res.json({ ready: expressServer ? true : false });
  });
  server.use((req, res, next) => {
    if (expressServer) return expressServer(req, res, next);
    res.sendFile(devLoadingHTMLFilepath);
  });
  const port = config.server?.port || process.env.PORT || 3000;
  server.listen(port, (err?: any) => {
    if (err) throw err;
    console.log(`⭐️ Dev Server Ready on http://localhost:${port}`);
    // Don't start initialising Keystone until the dev server is ready,
    // otherwise it slows down the first response significantly
    initKeystone().catch(err => {
      console.error(`🚨 There was an error initialising Keystone`);
      console.error(err);
      process.exit(1);
    });
  });
};
