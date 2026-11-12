import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from './http.mjs';
export function sqliteHeader(bytes){if(bytes.length<100||bytes.subarray(0,16).toString('binary')!=='SQLite format 3\x00')throw new Error('主库文件头无效');const raw=bytes.readUInt16BE(16);return {pageSize:raw===1?65536:raw,pages:bytes.readUInt32BE(28)};}
export async function inspect(base){const bytes=Buffer.from(await(await get(base,'/clean.sqlite')).arrayBuffer());const header=sqliteHeader(bytes);const directory=await mkdtemp(join(tmpdir(),'sqlite-inspect-'));let db;try{const path=join(directory,'copy.sqlite');await writeFile(path,bytes);db=new DatabaseSync(path,{readOnly:true});return {...header,rows:db.prepare('select id, location, note from inspections order by id').all()};}finally{db?.close();await rm(directory,{recursive:true,force:true});}}
