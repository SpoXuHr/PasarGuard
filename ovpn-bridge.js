'use strict';
// OpenVPN's TCP transport is a two-byte length prefix followed by the same
// OpenVPN datagram. Convert frames to local UDP without changing encrypted data.
const net=require('net'),dgram=require('dgram');
const server=net.createServer({allowHalfOpen:false},socket=>{
  const udp=dgram.createSocket('udp4'); let pending=Buffer.alloc(0),closed=false;
  const close=()=>{if(closed)return;closed=true;try{udp.close()}catch(_){}try{socket.destroy()}catch(_){}};
  socket.setNoDelay(true);socket.setKeepAlive(true,60000);socket.setTimeout(180000,close);
  udp.on('error',close);socket.on('error',close);socket.on('close',close);
  udp.on('message',msg=>{if(closed||msg.length>65535)return;const h=Buffer.allocUnsafe(2);h.writeUInt16BE(msg.length);socket.write(Buffer.concat([h,msg]));});
  socket.on('data',chunk=>{
    pending=Buffer.concat([pending,chunk]);
    if(pending.length>262144){close();return;}
    while(pending.length>=2){const n=pending.readUInt16BE(0);if(n===0){close();return;}if(pending.length<2+n)break;const frame=pending.subarray(2,2+n);pending=pending.subarray(2+n);udp.send(frame,21023,'127.0.0.1',err=>{if(err)close()});}
  });
});
server.on('error',err=>{console.error('OpenVPN TCP bridge failed:',err.message);process.exit(1)});
server.listen(21023,'127.0.0.1',()=>console.log('OpenVPN TCP bridge ready'));
