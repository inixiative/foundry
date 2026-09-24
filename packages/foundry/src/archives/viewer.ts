import { ContextStack, EventStream, Harness, InterventionLog, Thread } from '@inixiative/foundry-core';
import { ProjectRegistry } from '../agents/project';
import { ConfigStore } from '../viewer/config';
import { startViewer } from '../viewer/server';

// The archive console uses the normal viewer and journal without starting model workers.
const configDir = process.env.FOUNDRY_CONFIG_DIR ?? '.foundry';
const configStore = new ConfigStore(configDir);
const config = await configStore.load();
const projects = new ProjectRegistry();
projects.loadFromConfigs(config.projects);
const projectId = Object.keys(config.projects)[0];
const thread = new Thread('archive-console', new ContextStack(), {description:'Archive connection console',projectId,tags:[]});
if (projectId) projects.all.get(projectId)?.addThread(thread);
const events = new EventStream();
const viewer = await startViewer({harness:new Harness(thread),eventStream:events,interventions:new InterventionLog(thread.signals),projectRegistry:projects,configStore,configDir,port:Number(process.env.VIEWER_PORT ?? 4400)});
console.log('Foundry Archive console ready. Model workers are not started.');
process.once('SIGTERM',()=>{viewer.server.stop(true);process.exit(0)});
process.once('SIGINT',()=>{viewer.server.stop(true);process.exit(0)});
