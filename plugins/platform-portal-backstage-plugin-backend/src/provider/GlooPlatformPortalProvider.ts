import { Entity, EntityMeta } from '@backstage/catalog-model';
import { Config } from '@backstage/config';

import { PluginTaskScheduler } from '@backstage/backend-tasks';
import {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import fetch from 'node-fetch';
import * as winston from 'winston';
import { APIProduct, APISchema, AccessTokensResponse } from './api-types';
import {
  getClientId,
  getClientSecret,
  getPortalServerUrl,
  getServiceAccountPassword,
  getServiceAccountUsername,
  getTokenEndpoint,
} from './configHelpers';
import { doAccessTokenRequest, parseJwt } from './utility';

/**
 * Provides API entities from the Gloo Platform Portal REST server.
 */
export class GlooPlatformPortalProvider implements EntityProvider {
  private readonly env: string;
  private connection?: EntityProviderConnection;
  private logger: winston.Logger;
  private config: Config;
  private latestTokensResponse?: AccessTokensResponse;

  log = (s: string) => this.logger.info(`gloo-platform-portal: ${s}`);
  warn = (s: string) => this.logger.warn(`gloo-platform-portal: ${s}`);
  error = (s: string) => this.logger.error(`gloo-platform-portal: ${s}`);
  getProviderName = () => `gloo-platform-portal-${this.env}`;
  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
  }

  //
  // 1. Init class
  //
  constructor(env: string, logger: winston.Logger, config: Config) {
    this.env = env;
    this.logger = logger;
    this.config = config;
    this.log('Initializing GlooPlatformPortalProvider.');
    this.startTokensRequests();
  }

  //
  // 2. Get access_token
  //
  async startTokensRequests() {
    //
    // Make the initial request for the access_token.
    // this.log('Making the initial access_token request.');
    const res = await doAccessTokenRequest(
      'password',
      getTokenEndpoint(this.warn, this.config),
      getClientId(this.warn, this.config),
      getClientSecret(this.warn, this.config),
      getServiceAccountUsername(this.warn, this.config),
      getServiceAccountPassword(this.warn, this.config),
    );
    this.latestTokensResponse = res;
    // this.log('Got the initial access_token.');
    //
    // Set up a timeout to get refresh tokens this
    // updates this.latestToken on each callback.
    this.refreshTheToken();
  }

  /**
   *
   * 3. Get refresh_tokens.
   *
   * Calling this will refresh the access_token when it is expiring soon,
   * using the refresh_token in the access tokens response.
   * */
  async refreshTheToken() {
    const restartAccessTokenRequests = () => {
      // If there's a problem, wait to restart the access token
      // requests so as to not overload the auth server.
      this.warn('No latest access token. Re-requesting the access_token.');
      setTimeout(this.startTokensRequests, 5000);
    };
    if (!this.latestTokensResponse) {
      restartAccessTokenRequests();
      return;
    }
    //
    // Parse the access_token JWT to find when it expires.
    const parsedToken = parseJwt(this.latestTokensResponse.access_token);
    if (!parsedToken.exp) {
      this.warn('No `exp` property found in the access_token JWT.');
    }
    const nowDate = new Date();
    const expiresDate = new Date(parsedToken.exp * 1000);
    const millisUntilExpires = expiresDate.getTime() - nowDate.getTime();
    if (millisUntilExpires <= 0) {
      this.warn('access token is expired!');
      this.latestTokensResponse = undefined;
      return;
    }
    // this.log('Setting a timeout to refresh the token.');
    // Set the timeout to request new tokens.
    setTimeout(
      async () => {
        if (!this.latestTokensResponse) {
          restartAccessTokenRequests();
          return;
        }
        try {
          // this.log('Making a refresh_token request.');
          const res = await doAccessTokenRequest(
            'refresh_token',
            getTokenEndpoint(this.warn, this.config),
            getClientId(this.warn, this.config),
            getClientSecret(this.warn, this.config),
            getServiceAccountUsername(this.warn, this.config),
            getServiceAccountPassword(this.warn, this.config),
            this.latestTokensResponse.refresh_token,
          );
          this.latestTokensResponse = res;
          // this.log('Got a new refresh_token.');
          // Recurse
          this.refreshTheToken();
        } catch (e) {
          if (!!e && typeof e === 'string') {
            this.warn(e);
          }
        }
      },
      // Don't make this request more than once a second,
      // and do the refresh 5 seconds early.
      Math.max(1000, millisUntilExpires - 5000),
    );
  }

  /**
   *
   * 4. Schedule sync.
   *
   * This is called during setup, and passes the user config into the
   * Backstage plugin task scheduler.
   * */
  async startScheduler(scheduler: PluginTaskScheduler) {
    const frequency = this.config.getOptionalConfig(
      'glooPlatformPortal.syncFrequency',
    );
    const timeout = this.config.getOptionalConfig(
      'glooPlatformPortal.syncTimeout',
    );
    await scheduler.scheduleTask({
      id: 'run_gloo_platform_portal_refresh',
      fn: async () => {
        await this.run();
      },
      frequency: !!frequency
        ? {
            hours: frequency.getOptionalNumber('hours'),
            minutes: frequency.getOptionalNumber('minutes'),
            seconds: frequency.getOptionalNumber('seconds'),
            milliseconds: frequency.getOptionalNumber('milliseconds'),
          }
        : {
            minutes: 5,
          },
      timeout: !!timeout
        ? {
            hours: timeout.getOptionalNumber('hours'),
            minutes: timeout.getOptionalNumber('minutes'),
            seconds: timeout.getOptionalNumber('seconds'),
            milliseconds: timeout.getOptionalNumber('milliseconds'),
          }
        : {
            seconds: 30,
          },
    });
  }

  /**
   *
   * 4. Return new Backstage entities.
   *
   * Requests API information from the Gloo Platform Portal REST server,
   * and transforms the response into Backstage API entities.
   */
  async run(): Promise<void> {
    if (!this.connection || !this.latestTokensResponse) {
      throw new Error('Not initialized');
    }

    const entities: Entity[] = [];
    const bsGroupName = 'solo-io-service-accounts';
    const bsServiceAccountName = 'gloo-platform-portal-service-account';
    const bsSystemName = 'gloo-platform-portal-apis';
    const portalServerUrl = getPortalServerUrl(this.warn, this.config);
    const apisEndpoint = `${portalServerUrl}/apis`;
    //
    // Make API request
    try {
      // TODO: Update this request once the server can optionally include the schema string in the response.
      const res = await fetch(apisEndpoint, {
        headers: {
          Authorization: `Bearer ${this.latestTokensResponse.access_token}`,
        },
      });
      const apiProducts = (await res.json()) as APIProduct[];
      // this.log(JSON.stringify(apiProducts));
      //
      // Convert the APIs to entities
      for (let i = 0; i < apiProducts.length; i++) {
        const apiProduct = apiProducts[i];
        // entities.push({
        //   apiVersion: 'backstage.io/v1alpha1',
        //   kind: 'Component',
        //   metadata: {
        //     tags: ['gloo-platform', 'api-product'],
        //     name: apiProduct.apiProductId,
        //     title: apiProduct.apiProductDisplayName,
        //     description: 'This is a Gloo Platform Portal ApiProduct.',
        //     annotations: {
        //       'backstage.io/managed-by-location': 'url:' + apisEndpoint,
        //       'backstage.io/managed-by-origin-location': 'url:' + apisEndpoint,
        //     },
        //   } as EntityMeta,
        //   spec: {
        //     type: 'service',
        //     lifecycle: 'production',
        //     owner: 'user:' + bsServiceAccountName,
        //     providesApis: apiProduct.apiVersions.map(api => api.apiId),
        //     system: bsSystemName,
        //   },
        // });
        for (let j = 0; j < apiProduct.apiVersions.length; j++) {
          const apiVersion = apiProduct.apiVersions[j];
          // TODO: Remove this once the schema is fetched along with the rest of the api info.
          const schemaRes = await fetch(
            `${apisEndpoint}/${apiVersion.apiId}/schema`,
            {
              headers: {
                Authorization: `Bearer ${this.latestTokensResponse.access_token}`,
              },
            },
          );
          const schema = (await schemaRes.json()) as APISchema;
          // this.log(JSON.stringify(schema));
          entities.push({
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'API',
            metadata: {
              tags: [
                'gloo-platform',
                'api-version-' + apiVersion.apiVersion.replaceAll(' ', '_'),
              ],
              name: apiVersion.apiId,
              title: apiVersion.apiId,
              description: apiVersion.description,
              annotations: {
                'backstage.io/managed-by-location': `url:${apisEndpoint}`,
                'backstage.io/managed-by-origin-location': `url:${apisEndpoint}`,
              },
            } as EntityMeta,
            spec: {
              type: 'openapi',
              lifecycle: 'production',
              system: bsSystemName,
              owner: `user:${bsServiceAccountName}`,
              // definition: 'openapi: "3.0.0"',
              definition: JSON.stringify(schema),
            },
          });
        }
      }
      // this.log(JSON.stringify(entities));
    } catch (e) {
      this.error(
        `Could not get APIs from the portal server endpoint (${apisEndpoint}). Error: ${JSON.stringify(
          e,
        )}`,
      );
    }

    const locationKey = `gloo-platform-portal-provider:${this.env}`;
    await this.connection.applyMutation({
      type: 'full',
      entities: [
        {
          locationKey,
          entity: {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Group',
            metadata: {
              name: bsGroupName,
              annotations: {
                'backstage.io/managed-by-location': `url:${portalServerUrl}`,
                'backstage.io/managed-by-origin-location': `url:${portalServerUrl}`,
              },
            },
            spec: {
              type: 'service-account-group',
              children: [],
              members: [bsServiceAccountName],
            },
          },
        },
        {
          locationKey,
          entity: {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'User',
            metadata: {
              name: bsServiceAccountName,
              annotations: {
                'backstage.io/managed-by-location': `url:${portalServerUrl}`,
                'backstage.io/managed-by-origin-location': `url:${portalServerUrl}`,
              },
            },
            spec: {
              displayName: 'Solo.io Service Account',
              email: '',
              picture: '',
              memberOf: [bsGroupName],
            },
          },
        },
        // {
        //   locationKey,
        //   entity: {
        //     apiVersion: 'backstage.io/v1alpha1',
        //     kind: 'Domain',
        //     metadata: {
        //       tags: ['gloo-platform'],
        //       name: 'api-product',
        //       description: 'Gloo Platform Portal ApiProduct resources.',
        //       annotations: {
        //         'backstage.io/managed-by-location': 'url:' + apisEndpoint,
        //         'backstage.io/managed-by-origin-location':
        //           'url:' + apisEndpoint,
        //       },
        //     } as EntityMeta,
        //     spec: {
        //       owner: 'user:' + bsServiceAccountName,
        //     },
        //   },
        // },
        {
          locationKey,
          entity: {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'System',
            metadata: {
              tags: ['gloo-platform'],
              name: bsSystemName,
              title: 'Gloo Platform Portal APIs',
              annotations: {
                'backstage.io/managed-by-location': `url:${apisEndpoint}`,
                'backstage.io/managed-by-origin-location': `url:${apisEndpoint}`,
              },
            } as EntityMeta,
            spec: {
              owner: `user:${bsServiceAccountName}`,
              // domain: 'api-product',
            },
          },
        },
        ...entities.map(entity => ({ locationKey, entity })),
      ],
    });
  }
}
