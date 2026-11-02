import { readFileSync } from 'node:fs';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { AppStoreServerAPIClient, SignedDataVerifier, Environment, Type, Status } from '@apple/app-store-server-library';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSACTION = /^[0-9]{1,40}$/;
const JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const inactive = (configured = false) => ({ active:false, product_id:null, expires_at:null, environment:null, configured });
export class BillingError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}

// The official library signs requests and verifies Apple's certificate chain. Bound
// network time here because its default fetch has no application timeout.
class TimedAppleClient extends AppStoreServerAPIClient {
  constructor(key, keyID, issuer, bundle, environment) {
    super(key, keyID, issuer, bundle, environment);
    this.endpoint = environment === Environment.PRODUCTION ? 'https://api.storekit.apple.com' : 'https://api.storekit-sandbox.apple.com';
  }
  async makeFetchRequest(path, parameters, method, requestBody, headers) {
    const url = new URL(path, this.endpoint);
    url.search = parameters.toString();
    return fetch(url, { method, headers, body:requestBody, signal:AbortSignal.timeout(10000) });
  }
}

/** No Xcode/local-testing environment is accepted by a deployed backend. */
export function appleBillingConfiguration(env = process.env) {
  const fields = ['APPSTORE_BUNDLE_ID','APPSTORE_APP_APPLE_ID','APPSTORE_ISSUER_ID','APPSTORE_KEY_ID',
    'APPSTORE_PRIVATE_KEY_PATH','APPSTORE_ROOT_CA_PATHS','APPSTORE_PRODUCT_IDS','APPSTORE_ENVIRONMENTS'];
  if (fields.some(key => !env[key]?.trim() || env[key].includes('REEMPLAZAR'))) return null;
  const appAppleID = Number(env.APPSTORE_APP_APPLE_ID);
  const products = env.APPSTORE_PRODUCT_IDS.split(',').map(s=>s.trim()).filter(Boolean);
  const environments = env.APPSTORE_ENVIRONMENTS.split(',').map(s=>s.trim()).filter(Boolean);
  if (!Number.isSafeInteger(appAppleID) || appAppleID <= 0 || !UUID.test(env.APPSTORE_ISSUER_ID)
    || !/^[A-Za-z0-9]{10}$/.test(env.APPSTORE_KEY_ID) || !/^[A-Za-z0-9.-]{3,200}$/.test(env.APPSTORE_BUNDLE_ID)
    || !products.length || products.length > 20 || products.some(p=>!/^[-A-Za-z0-9._]{1,200}$/.test(p))
    || !environments.length || environments.some(e=>![Environment.PRODUCTION,Environment.SANDBOX].includes(e))) {
    throw new Error('Configuración APPSTORE inválida.');
  }
  const roots = env.APPSTORE_ROOT_CA_PATHS.split(',').map(path=>readFileSync(path.trim()));
  if (!roots.length || roots.some(root=>!new X509Certificate(root).ca)) throw new Error('Certificados raíz Apple inválidos.');
  const key = readFileSync(env.APPSTORE_PRIVATE_KEY_PATH, 'utf8');
  const privateKey = createPrivateKey(key);
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('La clave Apple debe ser una clave privada EC P-256.');
  const connections = new Map(environments.map(environment=>[environment, {
    verifier:new SignedDataVerifier(roots, true, environment, env.APPSTORE_BUNDLE_ID, appAppleID),
    client:new TimedAppleClient(key, env.APPSTORE_KEY_ID, env.APPSTORE_ISSUER_ID, env.APPSTORE_BUNDLE_ID, environment)
  }]));
  return { bundleID:env.APPSTORE_BUNDLE_ID, appAppleID, products:new Set(products), connections };
}

/** Persistence stores bindings and notification IDs, never a client premium flag.
 * Every entitlement decision queries Apple's current status, including cache hits
 * in the AI layer. An old, genuine purchase JWS cannot resurrect a refunded plan.
 */
export function createAppleBilling({ configuration = null, repository, now = Date.now } = {}) {
  const configured = !!configuration && !!repository?.configured;
  const assertConfigured = () => { if (!configured) throw new BillingError('billing_not_configured'); };
  function validateTransaction(tx, userID, environment) {
    if (tx?.bundleId !== configuration.bundleID || tx.environment !== environment || !configuration.products.has(tx.productId)
      || tx.type !== Type.AUTO_RENEWABLE_SUBSCRIPTION || !TRANSACTION.test(tx.originalTransactionId || '')
      || !TRANSACTION.test(tx.transactionId || '') || !UUID.test(tx.appAccountToken || '')
      || tx.appAccountToken.toLowerCase() !== userID.toLowerCase()
      || !Number.isSafeInteger(tx.signedDate) || tx.signedDate > now()+60000) throw new BillingError('invalid_purchase',400);
    return tx;
  }
  async function decode(signed, method) {
    assertConfigured();
    if (typeof signed !== 'string' || signed.length > 40000 || !JWS.test(signed)) throw new BillingError('invalid_purchase',400);
    for (const [environment, connection] of configuration.connections) {
      try { return { environment, decoded:await connection.verifier[method](signed) }; } catch { /* Try only configured Apple environments. */ }
    }
    throw new BillingError('invalid_purchase',400);
  }
  async function current(userID, originalID, environment) {
    const connection = configuration.connections.get(environment);
    if (!connection || !TRANSACTION.test(originalID)) throw new BillingError('invalid_purchase',400);
    const response = await connection.client.getAllSubscriptionStatuses(originalID);
    if (response.bundleId !== configuration.bundleID || response.environment !== environment
      || Number(response.appAppleId) !== configuration.appAppleID || !Array.isArray(response.data)) throw new BillingError('billing_unavailable');
    const items = response.data.flatMap(group=>group.lastTransactions || []);
    if (items.length > 40) throw new BillingError('billing_unavailable');
    const records = [];
    for (const item of items) {
      const tx = await connection.verifier.verifyAndDecodeTransaction(item.signedTransactionInfo);
      // The API may return a different subscription group; its account binding
      // still has to match. Unrecognised products never grant access.
      if (!configuration.products.has(tx.productId)) continue;
      validateTransaction(tx,userID,environment);
      if (item.originalTransactionId !== tx.originalTransactionId) throw new BillingError('invalid_purchase',400);
      let expires = Number.isSafeInteger(tx.expiresDate) ? tx.expiresDate : 0;
      let active = item.status === Status.ACTIVE && expires > now();
      if (item.status === Status.BILLING_GRACE_PERIOD) {
        if (!item.signedRenewalInfo) throw new BillingError('billing_unavailable');
        const renewal = await connection.verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo);
        if (renewal.originalTransactionId !== tx.originalTransactionId || renewal.environment !== environment
          || (renewal.appAccountToken && renewal.appAccountToken.toLowerCase() !== userID.toLowerCase())
          || !Number.isSafeInteger(renewal.signedDate) || renewal.signedDate > now()+60000) throw new BillingError('invalid_purchase',400);
        expires = Number.isSafeInteger(renewal.gracePeriodExpiresDate) ? renewal.gracePeriodExpiresDate : 0;
        active = expires > now();
      }
      if (tx.revocationDate != null || tx.isUpgraded === true) active = false;
      records.push({ original_transaction_id:tx.originalTransactionId, environment, product_id:tx.productId,
        expires_at:expires > 0 ? new Date(expires).toISOString() : null, status:Number(item.status)||0, active });
    }
    return records;
  }
  function result(records) {
    const sorted = [...records].sort((a,b)=>Number(b.active)-Number(a.active) || (Date.parse(b.expires_at)||0)-(Date.parse(a.expires_at)||0));
    const item = sorted[0];
    return item ? { active:item.active, product_id:item.product_id, expires_at:item.expires_at, environment:item.environment, configured:true } : inactive(true);
  }
  async function refresh(userID, bindings) {
    const environments = new Map();
    for (const binding of bindings) if (!environments.has(binding.environment)) environments.set(binding.environment,binding.original_transaction_id);
    const records = [];
    for (const [environment, originalID] of environments) records.push(...await current(userID,originalID,environment));
    for (const record of records) await repository.record(userID,record);
    return records;
  }
  return {
    configured,
    async status(user) {
      if (!configured) return inactive(false);
      const bindings = await repository.list(user.id);
      if (!Array.isArray(bindings) || bindings.length > 40) throw new BillingError('billing_unavailable');
      return result(await refresh(user.id,bindings));
    },
    async verify(user,signed) {
      const { environment, decoded:tx } = await decode(signed,'verifyAndDecodeTransaction');
      validateTransaction(tx,user.id,environment);
      const records = await refresh(user.id,[{environment,original_transaction_id:tx.originalTransactionId}]);
      // Keep a verified expired binding so future server-status checks can find
      // renewals. No entitlement is inferred from this submitted JWS.
      if (!records.some(r=>r.original_transaction_id === tx.originalTransactionId)) await repository.record(user.id,{
        original_transaction_id:tx.originalTransactionId, environment, product_id:tx.productId, expires_at:null,status:Status.EXPIRED,active:false
      });
      return result(records);
    },
    async notification(signed) {
      const { environment, decoded:notification } = await decode(signed,'verifyAndDecodeNotification');
      if (!UUID.test(notification.notificationUUID || '')) throw new BillingError('invalid_notification',400);
      if (await repository.seen(notification.notificationUUID)) return { received:true, duplicate:true };
      if (notification.notificationType === 'TEST') {
        await repository.record(null,null,notification.notificationUUID); return { received:true };
      }
      if (!notification.data?.signedTransactionInfo) {
        // Summary/external-purchase notifications do not grant this app's AI.
        await repository.record(null,null,notification.notificationUUID); return { received:true, ignored:true };
      }
      const connection = configuration.connections.get(environment);
      const tx = await connection.verifier.verifyAndDecodeTransaction(notification.data.signedTransactionInfo);
      if (!UUID.test(tx.appAccountToken || '') || !configuration.products.has(tx.productId)) {
        await repository.record(null,null,notification.notificationUUID); return { received:true, ignored:true };
      }
      const userID = tx.appAccountToken.toLowerCase();
      validateTransaction(tx,userID,environment);
      const records = await current(userID,tx.originalTransactionId,environment);
      const record = records.find(r=>r.original_transaction_id===tx.originalTransactionId) || {
        original_transaction_id:tx.originalTransactionId, environment, product_id:tx.productId, expires_at:null,status:Status.EXPIRED,active:false
      };
      await repository.record(userID,record,notification.notificationUUID);
      return { received:true };
    }
  };
}
