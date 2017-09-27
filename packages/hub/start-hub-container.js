const crypto = require('crypto');
const path = require('path');
const {promisify} = require('util');
const child_process = require('child_process');
const {spawn} = child_process;
const execFile = promisify(child_process.execFile);
const realpath = promisify(require('fs').realpath);

const Koa = require('koa');
const proxy = require('koa-proxy');
const nssocket = require('nssocket');
const path_is_inside = require('path-is-inside');
const Dockerfile = require('dockerfilejs').Dockerfile;
const resolve = promisify(require('resolve'));
const log = require('@cardstack/plugin-utils/logger')('hub/spawn-hub');

const HUB_HEARTBEAT_INTERVAL = 1 * 1000;

module.exports = async function(projectRoot) {
  let hubPath = await linkedHubPath(projectRoot);

  let hubBinding;
  if (hubPath) {
    log.info('Binding locally linked hub: '+hubPath);
    hubBinding = [
      '--mount', `type=bind,src=${hubPath},dst=/hub/app/node_modules/@cardstack/hub`
    ];
  } else {
    hubBinding = [];
  }

  let key = crypto.randomBytes(32).toString('base64');

  await buildAppImage();

  await execFile('docker', [
    'run',
    '-d',
    '--rm',
    '--publish', '3000:3000',
    '--publish', '6785:6785',
    '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
    ...hubBinding,
    '-e', `CARDSTACK_SESSIONS_KEY=${key}`,
    'cardstack-app'
  ]);

  let hub = await socketToHub();

  await new Promise(function(resolve) {
    hub.data('ready', resolve);
  });

  log.info('Ready message received from hub container');

  let beat = function() {
    log.trace('Sending heartbeat to hub container');
    hub.send('heartbeat');
  };
  beat();
  setInterval(beat, HUB_HEARTBEAT_INTERVAL);

  let app = new Koa();
  app.use(proxy({
    host: 'http://localhost:3000'
  }));
  return app.callback();
};

async function buildAppImage() {
  let proc = spawn('docker', [
      'build',
      '-t', 'cardstack-app',
      '-f', '-',
      '.'
  ],{
    cwd: '/Users/aaron/dev/basic-cardstack',
    stdio: 'pipe'
  });


  let file = new Dockerfile();

  file.from('cardstack/hub')
    .workdir('/hub/app')
    .copy({src: ['package.json', 'yarn.lock'], dest: '/hub/app/'})
    .run('yarn install --frozen-lockfile')
    .copy({src: '.', dest: '/hub/app'})
    .env({
      ELASTICSEARCH: 'http://elasticsearch:9200',
      DEBUG: 'cardstack/*'
    })
    .cmd({command:'node', params: [
      '/hub/app/node_modules/@cardstack/hub/bin/server.js',
      '/hub/app/cardstack/seeds/development',
      '-d',
      '--containerized'
    ]});

  proc.stdin.end(file.render());

  await new Promise(function(resolve, reject) {
    proc.on('error', reject);
    proc.on('exit', resolve);
  });
}

async function linkedHubPath(projectRoot) {
  let hubPath = path.dirname(await resolve('@cardstack/hub/package.json', {basedir: projectRoot}));
  hubPath = await realpath(hubPath);

  // If hub is coming from outside our node_modules, we're linked to it,
  // so we should bind it in the container as well
  if (!path_is_inside(hubPath, projectRoot)) {
    return hubPath;
  } else {
    return false;
  }
}

async function socketToHub() {
  let hub = new nssocket.NsSocket();
  hub.connect(6785);

  return new Promise(function(resolve) {
    hub.data('shake', function() {
      resolve(hub);
    });
    hub.on('close', function() {
      resolve(socketToHub());
    });
    hub.send('hand');
  });


}