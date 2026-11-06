export const SECURITY_PROJECT = 'demo-qr-security';
export const EMULATOR_HOST = '127.0.0.1:8080';

/** Fail before loading SDKs or fixtures if the destination is not isolated. */
export function assertIsolatedEnvironment(env = process.env) {
  if (env.FIRESTORE_EMULATOR_HOST !== EMULATOR_HOST) {
    throw new Error('Security tests require the loopback Firestore emulator at ' + EMULATOR_HOST);
  }
  const projects = [env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT].filter(Boolean);
  if (!projects.length || projects.some(id => !/^demo-qr-[a-z0-9-]+$/.test(id))) {
    throw new Error('Security tests require demo-qr-* project IDs');
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS || env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE || env.FIREBASE_TOKEN) {
    throw new Error('Security tests refuse production credential configuration');
  }
  if (env.FIREBASE_CONFIG) {
    let config;
    try { config = JSON.parse(env.FIREBASE_CONFIG); }
    catch { throw new Error('Security tests refuse external Firebase config files'); }
    if (!config || !/^demo-qr-[a-z0-9-]+$/.test(config.projectId)
        || Object.keys(config).some(key => key !== 'projectId')) {
      throw new Error('Security tests refuse non-demo Firebase configuration');
    }
  }
  return {host: EMULATOR_HOST, projectId: projects[0]};
}

export function isolatedChildEnvironment(env = process.env) {
  const clean = {...env};
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'FIREBASE_TOKEN',
    'QR_SECURITY_BASELINE', 'QR_SECURITY_RULES_PATH', 'QR_SECURITY_FUNCTIONS_MODULE']) delete clean[key];
  clean.GCLOUD_PROJECT = SECURITY_PROJECT;
  clean.GOOGLE_CLOUD_PROJECT = SECURITY_PROJECT;
  clean.FIREBASE_CONFIG = JSON.stringify({projectId: SECURITY_PROJECT});
  clean.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
  return clean;
}
