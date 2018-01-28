import {
  difference,
  findKey,
  intersection,
  isEqual,
  partial
} from 'lodash';
import {
  diffLabels,
  initSwarm,
  joinNodes,
  promoteNodes,
  removeManagers,
  updateLabels
} from './swarm';
import chalk from 'chalk';
import debug from 'debug';
import {
  each
} from 'async';
import { map } from 'bluebird';
import nodemiral from 'nodemiral';

const log = debug('mup:module:docker');

function uniqueSessions(api) {
  const sessions = api.getSessions(['app', 'mongo', 'proxy']);

  return sessions.reduce(
    (prev, curr) => {
      if (prev.map(session => session._host).indexOf(curr._host) === -1) {
        prev.push(curr);
      }

      return prev;
    }, []
  );
}

export function setup(api) {
  log('exec => mup docker setup');
  const config = api.getConfig();
  const swarmEnabled = config.swarm;
  const servers = Object.keys(config.servers);

  const list = nodemiral.taskList('Setup Docker');

  list.executeScript('Setup Docker', {
    script: api.resolvePath(__dirname, 'assets/docker-setup.sh')
  });

  const sessions = swarmEnabled ?
    api.getSessionsForServers(servers) :
    uniqueSessions(api);

  if (sessions.length === 0) {
    // There are no servers, so we can skip running the list
    return;
  }

  return api
    .runTaskList(list, sessions, {
      verbose: api.verbose
    })
    .then(() => setupSwarm(api));
}

export async function setupSwarm(api) {
  const config = api.getConfig();
  const swarmConfig = config.swarm;
  if (!swarmConfig) {
    return;
  }

  let serverInfo = await api.getServerInfo();
  const {
    currentManagers,
    desiredManagers
  } = await api.swarmInfo();

  log('currentManagers', currentManagers);
  log('wantedManagers', desiredManagers);

  const managersToAdd = difference(desiredManagers, currentManagers);
  const managersToRemove = difference(currentManagers, desiredManagers);
  const managersToKeep = intersection(currentManagers, desiredManagers);

  log('managers to add', managersToAdd);
  log('managers to remove', managersToRemove);
  log('managers keeping', managersToKeep);

  if (currentManagers.length === 0) {
    log('Creating swarm cluster');
    const host = config.servers[managersToAdd[0]].host;

    await initSwarm(managersToAdd, host, api);

    managersToKeep.push(managersToAdd.shift());
    log('finished creating cluster');
    api.serverInfoStale();
  }

  // refresh server info after updating managers
  serverInfo = await api.getServerInfo();

  // TODO: we should always keep one manager until
  // after the new managers are added
  if (managersToRemove.length > 0) {
    removeManagers(managersToRemove, api);
    api.serverInfoStale();
  }

  const {
    nodes: currentNodes,
    nodeIDs,
    currentLabels,
    desiredLabels
  } = await api.swarmInfo();
  const wantedNodes = Object.keys(config.servers);
  const nodesToAdd = difference(wantedNodes, currentNodes);

  log('current nodes', currentNodes);
  log('adding nodes', nodesToAdd);

  if (nodesToAdd.length > 0) {
    // TODO: make sure token is for correct cluster
    const token = Object.keys(serverInfo)
      .reduce((result, item) => result || serverInfo[item].swarmToken, null);
    const managerIP = config.servers[desiredManagers[0]].host;
    await joinNodes(nodesToAdd, token, managerIP, api);
  }

  log('remaining managers to add', managersToAdd);
  if (managersToAdd.length > 0) {
    const managerIDs = managersToAdd
      .map(name => findKey(nodeIDs, partial(isEqual, name)));

    await promoteNodes(managersToKeep[0], managerIDs, api);
  }

  // Update tags
  let { toRemove, toAdd } = diffLabels(currentLabels, desiredLabels);
  if (toRemove.length > 0 || toAdd.length > 0) {
    toRemove = toRemove.map(data => {
      data.server = findKey(nodeIDs, partial(isEqual, data.server));

      return data;
    });

    toAdd = toAdd.map(data => {
      data.server = findKey(nodeIDs, partial(isEqual, data.server));

      return data;
    });

    await updateLabels(api, currentManagers[0], toAdd, toRemove);
  }
}

export function restart(api) {
  const list = nodemiral.taskList('Restart Docker Daemon');

  list.executeScript('Restart Docker', {
    script: api.resolvePath(__dirname, 'assets/docker-restart.sh')
  });

  const sessions = uniqueSessions(api);

  return api.runTaskList(list, sessions, {
    verbose: api.verbose
  });
}

export function removeSwarm(api) {
  const list = nodemiral.taskList('Removing swarm');
  const servers = Object.keys(api.getConfig().servers);
  const sessions = api.getSessionsForServers(servers);

  list.executeScript('Removing swarm', {
    script: api.resolvePath(__dirname, 'assets/swarm-leave.sh')
  });

  return api.runTaskList(list, sessions, {
    verbose: api.verbose
  });
}

export function ps(api) {
  const args = api.getArgs();
  args.shift();
  each(uniqueSessions(api), (session, cb) => {
    session.execute(`sudo docker ${args.join(' ')} 2>&1`, (err, code, logs) => {
      console.log(chalk.magenta(`[${session._host}]`) + chalk.blue(` docker ${args.join(' ')}`));
      console.log(logs.stdout);
      cb();
    });
  });
}

export async function status(api) {
  const config = api.getConfig();

  if (!config.servers) {
    return;
  }

  const results = await map(
    Object.values(config.servers),
    server => api.runSSHCommand(server, 'sudo service docker status && sudo docker version --format "{{.Server.Version}}"'),
    { concurrency: 2 }
  );

  const minMajor = 1;
  const minMinor = 13;
  const lines = [];
  let overallColor = chalk.green;
  results.forEach(result => {
    const outputLines = result.output.split('\n');
    let dockerStatus = outputLines.length === 1 ? 'Not installed' : 'stopped';
    const version = outputLines.length > 1 ? outputLines[outputLines.length - 2] : '';
    const versionParts = version.split('.');
    let versionColor = chalk.green;
    let statusColor = chalk.green;

    if (/\/(.*),/.test(result.output)) {
      dockerStatus = result.output.match(/\/(.*),/).pop();
    }

    if (parseInt(versionParts[0], 10) < minMajor) {
      versionColor = chalk.red;
      overallColor = chalk.red;
    } else if (
      parseInt(versionParts[0], 10) === minMajor &&
      parseInt(versionParts[1], 10) < minMinor
    ) {
      versionColor = chalk.red;
      overallColor = chalk.red;
    }

    if (dockerStatus !== 'running') {
      statusColor = chalk.red;
    }

    lines.push(` - ${result.host}: ${versionColor(version)} ${statusColor(dockerStatus)}`);
  });

  console.log(overallColor('\n=> Docker Status'));
  console.log(lines.join('\n'));

  if (!config.swarm) {
    return;
  }

  const { currentManagers, nodes } = await api.swarmInfo();
  const list = [];

  currentManagers.forEach(manager => {
    list.push(`- ${manager} (Manager)`);
  });

  difference(nodes, currentManagers).forEach(node => {
    list.push(`- ${node}`);
  });

  if (currentManagers.length === 0) {
    console.log('No swarm managers');

    return;
  }

  // TODO show swarm health:
  // https://docs.docker.com/engine/swarm/admin_guide/#monitor-swarm-health

  console.log(`Swarm Nodes: ${nodes.length}`);
  console.log(list.join('\n'));
}
