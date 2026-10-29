import {existsSync,mkdirSync,readdirSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {declarationPaths} from './dsh-type-paths.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(!process.env.DSH_ROOT)throw Error('Set DSH_ROOT to the selected installed DSH0.2.1-rc.2 package graph.');
const selected=resolve(process.env.DSH_ROOT);const sourceRoot=join(selected,'node_modules/@deepseek-ai');
const readManifest=(dir)=>JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));
// A source checkout does not link the CLI or every workspace package into its
// root node_modules; scan the workspace so installed graphs and checkouts both work.
const workspace=new Map();
const scan=(dir,depth)=>{if(depth<0||!existsSync(dir))return;
  for(const entry of readdirSync(dir,{withFileTypes:true})){if(!entry.isDirectory()||entry.name==='node_modules')continue;
    const sub=join(dir,entry.name);
    if(existsSync(join(sub,'package.json'))){try{const name=readManifest(sub).name;
      if(typeof name==='string'&&name.startsWith('@deepseek-ai/')&&!workspace.has(name))workspace.set(name,sub);}catch{}}
    else scan(sub,depth-1);}};
scan(join(selected,'apps'),0);scan(join(selected,'packages'),1);
const cliDir=existsSync(join(sourceRoot,'dsh'))?join(sourceRoot,'dsh'):workspace.get('@deepseek-ai/dsh');
if(!cliDir)throw Error('DSH_ROOT does not provide the @deepseek-ai/dsh CLI package');
const cli=readManifest(cliDir);
if(cli.version!=='0.2.1-rc.2')throw Error(`Expected DSH0.2.1-rc.2, found ${cli.version}`);
const manifest=readManifest(root);const prepared=new Map();
for(const name of readdirSync(sourceRoot)){const source=join(sourceRoot,name);if(existsSync(join(source,'package.json')))prepared.set(name,realpathSync(source));}
const required=[...Object.keys(manifest.peerDependencies??{}),...(manifest.dsh?.client?.inject??[])].filter(name=>name.startsWith('@deepseek-ai/'));
const runtimeRequire=createRequire(join(realpathSync(cliDir),'package.json'));
for(const name of required){const short=name.slice('@deepseek-ai/'.length);if(prepared.has(short))continue;
  let dir=workspace.get(name);
  // Packages the plugin installs itself (for example @deepseek-ai/cosmokit) stay as real dependencies.
  if(!dir&&existsSync(join(root,'node_modules','@deepseek-ai',short,'package.json')))continue;
  if(!dir)dir=dirname(runtimeRequire.resolve(name+'/package.json'));
  const pkg=readManifest(dir);
  if(name.startsWith('@deepseek-ai/dsh-')&&pkg.version!=='0.2.1-rc.2')throw Error(`Mismatched official DSH package ${name}`);
  prepared.set(short,realpathSync(dir));}
// Link the full workspace closure, matching what an installed graph provides;
// transitive declarations such as dsh-brand are not direct requirements.
for(const [name,dir]of workspace){const short=name.slice('@deepseek-ai/'.length);if(!prepared.has(short))prepared.set(short,realpathSync(dir));}
// Client modules augment the shared cordis Context; the plugin, the
// augmentations and the runtime must resolve one and the same cordis copy.
for(const extra of ['@deepseek-ai/cordis']){const short=extra.slice('@deepseek-ai/'.length);
  if(!prepared.has(short)&&!existsSync(join(sourceRoot,short)))prepared.set(short,realpathSync(dirname(runtimeRequire.resolve(extra+'/package.json'))));}
const targetRoot=join(root,'node_modules/@deepseek-ai');mkdirSync(targetRoot,{recursive:true});const paths={};
for(const [name,source]of prepared){const target=join(targetRoot,name);if(!existsSync(target)||realpathSync(target)!==source){rmSync(target,{recursive:true,force:true});symlinkSync(source,target,'dir');}Object.assign(paths,declarationPaths(readManifest(source),source));}
if(!paths['@deepseek-ai/dsh-session/types']||!paths['@deepseek-ai/dsh-brand'])throw Error('Missing official declaration exports');
// Pin React types to the plugin's own copy; workspace declarations may sit next
// to a different @types/react generation.
for(const [name,dir]of[['react','@types/react'],['react-dom','@types/react-dom']]){const target=join(root,'node_modules',dir);
  if(existsSync(target)){paths[name]=[target];paths[name+'/*']=[join(target,'*')];}}
writeFileSync(join(root,'node_modules/.relay-dsh-types.json'),JSON.stringify({compilerOptions:{paths}},null,2)+'\n');
console.log(`Selected DSH${cli.version}: ${prepared.size} packages, ${Object.keys(paths).length} declaration paths`);
