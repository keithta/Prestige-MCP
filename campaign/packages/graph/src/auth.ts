/**
 * Microsoft Entra ID authentication, app-only (client credentials).
 *
 * Why app-only and not delegated: the sending engine is unattended. Delegated
 * refresh tokens expire on 90-day inactivity and are revoked by a password
 * change, MFA re-registration, or a Conditional Access change -- any of which
 * would stall a campaign overnight with nobody present. App-only removes that
 * failure mode; least privilege is restored at the Exchange layer with an
 * ApplicationAccessPolicy (see docs/GRAPH-SETUP.md).
 *
 * Tokens are held IN MEMORY ONLY. They are never written to the database or to
 * disk.
 */
import { readFile } from 'node:fs/promises';
import { ConfidentialClientApplication, type Configuration } from '@azure/msal-node';
import type { GraphConfig } from '@campaign/core';

export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /** Discards the cached token so the next call re-authenticates. */
  invalidate(): void;
}

const SCOPE = 'https://graph.microsoft.com/.default';
/** Refresh at 80% of lifetime so a send never races an expiry. */
const REFRESH_RATIO = 0.8;

export class MsalTokenProvider implements TokenProvider {
  private client: ConfidentialClientApplication | null = null;
  private cached: { token: string; expiresAt: number } | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(private readonly config: GraphConfig) {}

  private async getClient(): Promise<ConfidentialClientApplication> {
    if (this.client) return this.client;

    const auth: Configuration['auth'] = {
      clientId: this.config.GRAPH_CLIENT_ID,
      authority: `${this.config.GRAPH_AUTHORITY_HOST}/${this.config.GRAPH_TENANT_ID}`,
    };

    if (this.config.GRAPH_CLIENT_CERTIFICATE_PATH) {
      // Certificate auth is preferred on the Windows production host: no shared
      // secret to rotate, and the private key can live in the machine store.
      const pem = await readFile(this.config.GRAPH_CLIENT_CERTIFICATE_PATH, 'utf8');
      auth.clientCertificate = {
        thumbprint: this.config.GRAPH_CLIENT_CERTIFICATE_THUMBPRINT ?? '',
        privateKey: pem,
        ...(this.config.GRAPH_CLIENT_CERTIFICATE_PASSWORD
          ? { passphrase: this.config.GRAPH_CLIENT_CERTIFICATE_PASSWORD }
          : {}),
      };
    } else {
      auth.clientSecret = this.config.GRAPH_CLIENT_SECRET;
    }

    // Non-standard authority hosts (the mock Graph server in tests) must be
    // explicitly trusted by MSAL.
    const isStandardAuthority = this.config.GRAPH_AUTHORITY_HOST.startsWith(
      'https://login.microsoftonline.com',
    );
    this.client = new ConfidentialClientApplication({
      auth: isStandardAuthority
        ? auth
        : { ...auth, knownAuthorities: [new URL(this.config.GRAPH_AUTHORITY_HOST).host] },
    });
    return this.client;
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && now < this.cached.expiresAt) return this.cached.token;
    // Collapse a stampede of concurrent sends into one token request.
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        const client = await this.getClient();
        const result = await client.acquireTokenByClientCredential({ scopes: [SCOPE] });
        if (!result?.accessToken) {
          throw new Error('Entra ID returned no access token');
        }
        const lifetimeMs = result.expiresOn
          ? result.expiresOn.getTime() - Date.now()
          : 3600_000;
        this.cached = {
          token: result.accessToken,
          expiresAt: Date.now() + Math.max(30_000, lifetimeMs * REFRESH_RATIO),
        };
        return result.accessToken;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  invalidate(): void {
    this.cached = null;
  }
}

/**
 * Minimal OAuth2 client-credentials provider used against the mock Graph
 * server, where MSAL's tenant discovery has nothing to discover.
 */
export class DirectTokenProvider implements TokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(private readonly config: GraphConfig) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.token;

    const url = `${this.config.GRAPH_AUTHORITY_HOST}/${this.config.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.config.GRAPH_CLIENT_ID,
      client_secret: this.config.GRAPH_CLIENT_SECRET ?? '',
      scope: SCOPE,
      grant_type: 'client_credentials',
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`token request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('token response contained no access_token');

    this.cached = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 * REFRESH_RATIO,
    };
    return json.access_token;
  }

  invalidate(): void {
    this.cached = null;
  }
}

export function createTokenProvider(config: GraphConfig): TokenProvider {
  const isRealGraph = config.GRAPH_AUTHORITY_HOST.startsWith('https://login.microsoftonline.com');
  return isRealGraph ? new MsalTokenProvider(config) : new DirectTokenProvider(config);
}
