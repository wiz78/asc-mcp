import { request } from 'node:http';

export const defaultSocket = '/Library/Application Support/ASCScoped/run/asc.sock';

export function discoverTools(app, {socketPath=defaultSocket, timeout=45_000}={}) {
  if (app === '--team') app = '@team';
  if (app !== '@team' && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(app || '')) throw new Error('Choose a configured app alias or --team.');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({app, operation: '_catalog', input: {}});
    const req = request({socketPath, method:'POST', path:'/call', agent:false,
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
      signal:AbortSignal.timeout(timeout)}, res => {
      const chunks=[]; let size=0;
      res.on('data', chunk => {
        size += chunk.length;
        if(size > 32*1024*1024) { res.destroy(); reject(new Error('Daemon discovery response is too large.')); }
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if(res.statusCode !== 200 || data.error) throw new Error(data.error || 'Daemon discovery failed (HTTP '+res.statusCode+').');
          if(!Array.isArray(data.result?.tools) || !data.result.tools.every(tool => typeof tool.name === 'string')) throw new Error('Invalid daemon discovery response.');
          resolve(data.result.tools);
        } catch(error) {reject(error);}
      });
    });
    req.on('error', error => reject(new Error('Local ASC daemon unavailable ('+(error.code || error.name)+'). Check launchd and socket permissions.')));
    req.end(body);
  });
}

export async function inspect(command, args, write=console.log) {
  const [app,...options]=args;
  let json=false, filter='', socketPath=defaultSocket;
  for(let index=0; index<options.length; index++) {
    const option=options[index];
    if(option === '--json') json=true;
    else if(['--filter','--socket'].includes(option)) {
      const value=options[++index];
      if(!value || value.startsWith('--')) throw new Error('Missing value for '+option+'.');
      if(option === '--filter') filter=value.toLowerCase(); else socketPath=value;
    } else throw new Error('Unknown option: '+option);
  }
  const tools=await discoverTools(app,{socketPath});
  if(command === 'status') {
    const status={available:true,scope:app,tools:tools.length,socket:socketPath};
    write(json?JSON.stringify(status,null,2):'Daemon reachable; scope '+app+' exposes '+tools.length+' tools.');
  } else {
    const selected=tools.filter(tool => (tool.name+' '+(tool.description||'')).toLowerCase().includes(filter)).sort((a,b)=>a.name.localeCompare(b.name));
    write(json?JSON.stringify(selected,null,2):selected.map(tool=>tool.name).join('\n'));
  }
}
