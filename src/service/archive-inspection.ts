import { inflateRawSync } from 'node:zlib';

const MAX_ENTRIES=1000, MAX_OUTPUT=32*1024*1024;
export function crc32(bytes: Uint8Array): number {
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
export function inspectZip(bytes: Buffer, verify=false) {
  let end=-1;
  for(let at=bytes.length-22;at>=Math.max(0,bytes.length-65557);at--){
    if(bytes.readUInt32LE(at)===0x06054b50 && at+22+bytes.readUInt16LE(at+20)===bytes.length){end=at;break;}
  }
  if(end<0)throw new Error('ZIP end record missing');
  const count=bytes.readUInt16LE(end+10), size=bytes.readUInt32LE(end+12), offset=bytes.readUInt32LE(end+16);
  if(bytes.readUInt16LE(end+4)!==0 || bytes.readUInt16LE(end+6)!==0 || bytes.readUInt16LE(end+8)!==count)throw new Error('Multi-disk ZIP unsupported');
  if(count===65535 || size===0xffffffff || offset===0xffffffff)throw new Error('ZIP64 unsupported');
  if(count>MAX_ENTRIES || offset+size!==end)throw new Error('ZIP central directory bounds invalid');
  const entries: {name:string;compressedBytes:number;uncompressedBytes:number;unsafe:boolean;verified:boolean}[]=[];
  const ranges: [number,number][]=[];let cursor=offset, total=0;
  for(let index=0;index<count;index++){
    if(cursor+46>end || bytes.readUInt32LE(cursor)!==0x02014b50)throw new Error('ZIP central header invalid');
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16);
    const compressed=bytes.readUInt32LE(cursor+20), expanded=bytes.readUInt32LE(cursor+24);
    const nameLength=bytes.readUInt16LE(cursor+28), extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32);
    const disk=bytes.readUInt16LE(cursor+34), external=bytes.readUInt32LE(cursor+38), local=bytes.readUInt32LE(cursor+42);
    if(cursor+46+nameLength+extra+comment>end || disk!==0 || compressed===0xffffffff || expanded===0xffffffff || local===0xffffffff)throw new Error('ZIP entry bounds invalid');
    const rawName=bytes.subarray(cursor+46,cursor+46+nameLength),name=rawName.toString('utf8');
    const unsafe=!name || name.includes('\0') || name.includes('\ufffd') || name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').includes('..') || ((external>>>16)&0xf000)===0xa000 || entries.some(entry=>entry.name===name);
    if(local+30>offset || bytes.readUInt32LE(local)!==0x04034b50)throw new Error('ZIP local header invalid');
    const localName=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28),data=local+30+localName+localExtra;
    if(data+compressed>offset || bytes.readUInt16LE(local+6)!==flags || bytes.readUInt16LE(local+8)!==method || !bytes.subarray(local+30,local+30+localName).equals(rawName))throw new Error('ZIP local/central mismatch');
    if(!(flags&8) && (bytes.readUInt32LE(local+14)!==crc || bytes.readUInt32LE(local+18)!==compressed || bytes.readUInt32LE(local+22)!==expanded))throw new Error('ZIP size/CRC header mismatch');
    if(ranges.some(([start,end])=>local<end && data+compressed>start))throw new Error('ZIP overlapping entries');
    ranges.push([local,data+compressed]);total+=expanded;
    if(total>MAX_OUTPUT || expanded>8*1024*1024)throw new Error('ZIP expanded size limit exceeded');
    if(flags&1 || ![0,8].includes(method))throw new Error('Encrypted or unsupported ZIP method');
    if(verify){
      const packed=bytes.subarray(data,data+compressed);
      const output=method===0?packed:inflateRawSync(packed,{maxOutputLength:Math.max(1,expanded)});
      if(output.length!==expanded || crc32(output)!==crc)throw new Error('ZIP content CRC/size mismatch');
    }
    entries.push({name,compressedBytes:compressed,uncompressedBytes:expanded,unsafe,verified:verify});
    cursor+=46+nameLength+extra+comment;
  }
  if(cursor!==end)throw new Error('ZIP central directory size mismatch');
  return {ok:entries.every(entry=>!entry.unsafe),entryCount:entries.length,entries,uncompressedBytes:total,verified:verify};
}
