import { credentialStorage } from "./credential-storage.js";

const REFRESH_MARGIN_MS = 60_000;

export class SupabaseAuthClient {
  constructor() {
    this.refreshPromise = null;
  }

  async getConfiguration() {
    const configuration = await credentialStorage.getConfiguration();
    if (!configuration) {
      throw new Error(
        "Configure a Supabase project ID and publishable key before signing in",
      );
    }
    return configuration;
  }

  async request(path, { body, accessToken, configuration } = {}) {
    const activeConfiguration =
      configuration || (await this.getConfiguration());
    const headers = {
      apikey: activeConfiguration.publishableKey,
      "Content-Type": "application/json",
      "X-Client-Info": "youtube-watchmarker-extension",
    };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    const response = await fetch(
      `${activeConfiguration.supabaseUrl}/auth/v1${path}`,
      {
        method: "POST",
        headers,
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        payload.msg ||
          payload.message ||
          payload.error_description ||
          payload.error ||
          `Supabase Auth failed with HTTP ${response.status}`,
      );
    }
    return payload;
  }

  createStoredSession(payload, previousSession = null) {
    const user = payload.user || {};
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
      userId: user.id || previousSession?.userId,
      email: user.email || previousSession?.email || null,
    };
  }

  async authenticate(configuration, email, password) {
    const payload = await this.request("/token?grant_type=password", {
      body: { email, password },
      configuration,
    });
    const session = this.createStoredSession(payload);
    return {
      auth: { authenticated: true, email: payload.user?.email || email },
      session,
    };
  }

  refreshSession() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performSessionRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async performSessionRefresh() {
    const previousSession = await credentialStorage.getSession();
    if (!previousSession?.refreshToken) {
      throw new Error("Supabase session is missing. Sign in again.");
    }

    try {
      const payload = await this.request("/token?grant_type=refresh_token", {
        body: { refresh_token: previousSession.refreshToken },
      });
      const session = this.createStoredSession(payload, previousSession);
      await credentialStorage.storeSession(session);
      return session;
    } catch (error) {
      await credentialStorage.clearSession();
      throw new Error(`Supabase session expired: ${error.message}`);
    }
  }

  async getAccessToken() {
    const session = await credentialStorage.getSession();
    if (!session) {
      throw new Error("Sign in to Supabase before accessing cloud data");
    }

    if (session.expiresAt - Date.now() <= REFRESH_MARGIN_MS) {
      return (await this.refreshSession()).accessToken;
    }
    return session.accessToken;
  }

  async testSession() {
    const configuration = await this.getConfiguration();
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${configuration.supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: configuration.publishableKey,
        Authorization: `Bearer ${accessToken}`,
        "X-Client-Info": "youtube-watchmarker-extension",
      },
    });

    if (!response.ok) {
      await credentialStorage.clearSession();
      throw new Error("Supabase Auth session is invalid. Sign in again.");
    }
    return response.json();
  }
}

export const supabaseAuthClient = new SupabaseAuthClient();
