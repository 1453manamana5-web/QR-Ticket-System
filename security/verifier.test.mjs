import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertIsolatedEnvironment, isolatedChildEnvironment, EMULATOR_HOST, SECURITY_PROJECT} from './isolation.mjs';

const valid = () => ({
  FIRESTORE_EMULATOR_HOST: EMULATOR_HOST,
  GCLOUD_PROJECT: SECURITY_PROJECT,
  GOOGLE_CLOUD_PROJECT: SECURITY_PROJECT,
  FIREBASE_CONFIG: JSON.stringify({projectId: SECURITY_PROJECT}),
});

test('verifier: the isolated destination is accepted without loading an SDK', () => {
  assert.deepEqual(assertIsolatedEnvironment(valid()), {host: EMULATOR_HOST, projectId: SECURITY_PROJECT});
});

test('verifier: missing, remote and URL-shaped emulator destinations fail closed', () => {
  for (const host of [undefined, '', 'localhost:8080', '192.0.2.1:8080', 'firestore.googleapis.com:443', 'http://127.0.0.1:8080', '127.0.0.1:8081']) {
    assert.throws(() => assertIsolatedEnvironment({...valid(), FIRESTORE_EMULATOR_HOST: host}), /loopback/);
  }
});

test('verifier: both project selectors must remain demonstrably non-production', () => {
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
    assert.throws(() => assertIsolatedEnvironment({...valid(), [key]: 'production-project'}), /demo-qr-/);
  }
  const empty = valid();
  delete empty.GCLOUD_PROJECT;
  delete empty.GOOGLE_CLOUD_PROJECT;
  assert.throws(() => assertIsolatedEnvironment(empty), /demo-qr-/);
});

test('verifier: production credential selectors are rejected before application imports', () => {
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'FIREBASE_TOKEN']) {
    assert.throws(() => assertIsolatedEnvironment({...valid(), [key]: 'fixture-credential-selector'}), /credential/);
  }
});

test('verifier: external config filenames, malformed JSON and production project configuration are refused', () => {
  for (const value of ['/tmp/firebase-config.json', '{', '{}', 'null', JSON.stringify({projectId: 'production-project'})]) {
    assert.throws(() => assertIsolatedEnvironment({...valid(), FIREBASE_CONFIG: value}), /config/i);
  }
});

test('verifier: demo project configuration cannot smuggle external resources or credential fields', () => {
  for (const extra of [
    {databaseURL: 'https://fixture-project.firebaseio.com'},
    {storageBucket: 'fixture-project.appspot.com'},
    {credential: {client_email: 'fixture@example.invalid'}},
    {apiKey: 'fixture-key'},
  ]) {
    assert.throws(() => assertIsolatedEnvironment({...valid(), FIREBASE_CONFIG: JSON.stringify({projectId: SECURITY_PROJECT, ...extra})}), /config/i);
  }
});

test('verifier: the runner sanitizes inherited credentials and pins all project selectors', () => {
  const inherited = {
    FIRESTORE_EMULATOR_HOST: '192.0.2.1:8080',
    GCLOUD_PROJECT: 'production-project',
    GOOGLE_CLOUD_PROJECT: 'production-project',
    FIREBASE_CONFIG: '/tmp/production-config.json',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/fixture-credentials.json',
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/tmp/fixture-credentials.json',
    FIREBASE_TOKEN: 'fixture-token',
    QR_SECURITY_BASELINE: '1',
    QR_SECURITY_RULES_PATH: '/tmp/fixture-old.rules',
    QR_SECURITY_FUNCTIONS_MODULE: '/tmp/fixture-old-functions.js',
    PATH: '/usr/bin',
  };
  const isolated = isolatedChildEnvironment(inherited);
  assert.deepEqual(assertIsolatedEnvironment(isolated), {host: EMULATOR_HOST, projectId: SECURITY_PROJECT});
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'FIREBASE_TOKEN',
    'QR_SECURITY_BASELINE', 'QR_SECURITY_RULES_PATH', 'QR_SECURITY_FUNCTIONS_MODULE']) {
    assert.equal(key in isolated, false);
    assert.ok(inherited[key], 'parent environment remains untouched');
  }
  assert.equal(isolated.GCLOUD_PROJECT, SECURITY_PROJECT);
  assert.equal(isolated.GOOGLE_CLOUD_PROJECT, SECURITY_PROJECT);
  assert.deepEqual(JSON.parse(isolated.FIREBASE_CONFIG), {projectId: SECURITY_PROJECT});
  assert.equal(isolated.PATH, '/usr/bin');
});
