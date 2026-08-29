// @ts-check

/**
 * Database provider action handlers
 * Handles provider switching, status, syncing, and migration
 */

import { credentialStorage } from "../credential-storage.js";
import { databaseProviderFactory } from "../database-provider-factory.js";
import { createHandler } from "../handler-wrapper.js";
import { supabaseAuthClient } from "../supabase-auth-client.js";
import { supabaseDatabaseProvider } from "../supabase-database-provider.js";

/**
 * Get database provider status
 */
export const handleProviderStatus = createHandler(
  async () => {
    const status = databaseProviderFactory.getProviderStatus();
    return { status };
  },
  { name: "handleProviderStatus", requiresRequest: false },
);

/**
 * Switch database provider
 */
export const handleProviderSwitch = createHandler(async (request) => {
  const { provider } = request;

  if (!provider || !["indexeddb", "supabase"].includes(provider)) {
    return { success: false, error: "Invalid provider type" };
  }

  if (provider === "indexeddb") {
    const success = await databaseProviderFactory.switchToIndexedDB();
    if (success) {
      return { message: `Successfully switched to ${provider}` };
    } else {
      return { success: false, error: `Failed to switch to ${provider}` };
    }
  } else if (provider === "supabase") {
    await databaseProviderFactory.switchToSupabase();
    return { message: `Successfully switched to ${provider}` };
  }
}, "handleProviderSwitch");

/**
 * Get available providers
 */
export const handleProviderList = createHandler(
  async () => {
    const providers = await databaseProviderFactory.getAvailableProviders();
    return { providers };
  },
  { name: "handleProviderList", requiresRequest: false },
);

/**
 * Migrate data between providers
 */
export const handleProviderMigrate = createHandler(async (request) => {
  const { fromProvider, toProvider } = request;

  if (!fromProvider || !toProvider) {
    return { success: false, error: "Missing source or target provider" };
  }

  const success = await databaseProviderFactory.migrateData(
    fromProvider,
    toProvider,
  );
  if (success) {
    return {
      message: `Successfully migrated data from ${fromProvider} to ${toProvider}`,
    };
  } else {
    return { success: false, error: "Migration failed" };
  }
}, "handleProviderMigrate");

/**
 * Sync data between providers
 */
export const handleProviderSync = createHandler(async (request) => {
  const { providers } = request;

  if (!providers || !Array.isArray(providers) || providers.length !== 2) {
    return { success: false, error: "Invalid providers array" };
  }

  const success = await databaseProviderFactory.syncProviders(
    providers[0],
    providers[1],
  );
  if (success) {
    return {
      message: `Successfully synced data between ${providers[0]} and ${providers[1]}`,
    };
  } else {
    return { success: false, error: "Sync failed" };
  }
}, "handleProviderSync");

function requireEmailAndPassword(request) {
  const email = request.email?.trim();
  const password = request.password;
  if (!email || !password) {
    throw new Error("Email and password are required");
  }
  return { email, password };
}

export const handleSupabaseSaveCredentials = createHandler(async (request) => {
  const { configuration } = request;
  const validation = credentialStorage.validateConfiguration(configuration);
  if (!validation.isValid) {
    throw new Error(validation.errors.join(". "));
  }

  const { email, password } = requireEmailAndPassword(request);
  const { auth, session } = await supabaseAuthClient.authenticate(
    {
      ...configuration,
      supabaseUrl: `https://${configuration.projectId}.supabase.co`,
    },
    email,
    password,
  );
  await credentialStorage.storeAuthenticatedConfiguration(
    { ...configuration, email, password },
    session,
  );
  await supabaseDatabaseProvider.close();
  return { auth };
}, "handleSupabaseSaveCredentials");

/**
 * Test Supabase connection
 */
export const handleSupabaseTest = createHandler(
  async () => {
    await supabaseAuthClient.testSession();
    const success = await supabaseDatabaseProvider.testConnection();
    if (success) {
      return { message: "Supabase connection test successful" };
    } else {
      return { success: false, error: "Supabase connection test failed" };
    }
  },
  { name: "handleSupabaseTest", requiresRequest: false },
);

/**
 * Get Supabase credentials (masked)
 */
export const handleSupabaseGetCredentials = createHandler(
  async () => {
    const credentials = await credentialStorage.getMaskedCredentials();
    return { credentials };
  },
  { name: "handleSupabaseGetCredentials", requiresRequest: false },
);

/**
 * Get Supabase status
 */
export const handleSupabaseGetStatus = createHandler(
  async () => {
    const status = await credentialStorage.getCredentialStatus();
    return { status };
  },
  { name: "handleSupabaseGetStatus", requiresRequest: false },
);

/**
 * Check if Supabase table exists
 */
export const handleSupabaseCheckTable = createHandler(
  async () => {
    const tableStatus = await supabaseDatabaseProvider.checkTableStatus();
    return { tableExists: tableStatus.exists, tableStatus };
  },
  { name: "handleSupabaseCheckTable", requiresRequest: false },
);
