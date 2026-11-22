// Pure installation ownership model. No account, filesystem, or launchd effects.
export const BASE = '/Library/Application Support/ASCScoped';
export const PLIST = '/Library/LaunchDaemons/local.asc-scoped.plist';
export function installPlan({userExists, groupExists, memberExists, createUser = false, client, secureToken = 'DISABLED'}) {
  if (typeof client !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(client ?? '') || client === 'root' || client === 'ascdaemon') throw new Error('Choose a normal local client account.');
  if (!userExists && !createUser) throw new Error('Service user missing: rerun in your Terminal with --create-service-user to consent to creation.');
  if (userExists && secureToken !== 'DISABLED') throw new Error('ascdaemon must have Secure Token DISABLED; existing tokens are never changed.');
  return {version:1, base:BASE, plist:PLIST, user:'ascdaemon', group:'ascclients', client, createdUser:!userExists, createdGroup:!groupExists, addedMembership:!memberExists};
}
export function uninstallPlan(m) {
  if (m?.version !== 1 || m.base !== BASE || m.plist !== PLIST || m.user !== 'ascdaemon' || m.group !== 'ascclients' || typeof m.client !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(m.client ?? '') || ['root','ascdaemon'].includes(m.client) || !['createdUser','createdGroup','addedMembership'].every(k => typeof m[k] === 'boolean')) throw new Error('Invalid installation manifest; refusing removal.');
  return [['bootout','system/local.asc-scoped'],['remove',PLIST],['remove',BASE],...(m.addedMembership ? [['removeMembership',m.client,'ascclients']] : []),...(m.createdGroup ? [['deleteGroup','ascclients']] : []),...(m.createdUser ? [['deleteUser','ascdaemon']] : [])];
}
