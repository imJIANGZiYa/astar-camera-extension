/* Local-only image sharing. QR dependencies are bundled; no upload or remote code. */
(() => {
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const keyword = 'citypaipai';
  const diagonal = Math.hypot(36, 24);
  const fovFromFocal = mm => 2 * Math.atan(diagonal / (2 * mm)) * 180 / Math.PI;
  const focalFromFov = fov => diagonal / (2 * Math.tan(fov * Math.PI / 360));
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const fail = () => { throw new Error('图片中的机位参数损坏或版本不受支持。'); };
  const validate = data => {
    const c = data?.camera, t = data?.target, sky = data?.sky;
    if (data?.v !== 1 || !c || ![c.x,c.y,c.z,c.heading,c.tilt,c.fov].every(Number.isFinite) ||
        Math.abs(c.x) > 1e9 || Math.abs(c.y) > 1e9 || Math.abs(c.z) > 1e7 ||
        c.heading < 0 || c.heading >= 360 || c.tilt < 0 || c.tilt > 180 || c.fov < 1 || c.fov > 170 ||
        ![4326,3857,102100].includes(c.spatialReference?.wkid) ||
        !['landscape','portrait'].includes(data.orientation) ||
        typeof data.name !== 'string' || [...data.name].length > 40 ||
        !sky || typeof sky.visible !== 'boolean' || sky.timezone !== 'UTC+8') fail();
    if (c.spatialReference.wkid === 4326 && (Math.abs(c.x) > 180 || Math.abs(c.y) > 90)) fail();
    if (t != null && (![t.longitude,t.latitude,t.z].every(Number.isFinite) || Math.abs(t.longitude) > 180 || Math.abs(t.latitude) > 90)) fail();
    const date = globalThis.cityCelestial.parseShanghaiTime(sky.date, sky.time);
    const local = new Date(date.getTime() + 8 * 3600000).toISOString();
    if (!local.startsWith(`${sky.date}T${sky.time.length === 5 ? sky.time+':00' : sky.time}`)) fail();
    return data;
  };
  // Compact, versioned, checksummed payload fits an offline QR without a server URL.
  const pack = data => {
    validate(data);
    const c = data.camera, t = data.target, s = data.sky;
    const bytes = encoder.encode(JSON.stringify([1,[c.x,c.y,c.z,c.heading,c.tilt,c.fov,c.spatialReference.wkid],
      t ? [t.longitude,t.latitude,t.z] : null,data.orientation === 'portrait' ? 1 : 0,data.name,
      [s.date,s.time,s.visible ? 1 : 0]]));
    let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
    return 'CPP1:' + btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'') + ':' + crc32(bytes).toString(16).padStart(8,'0');
  };
  const unpack = text => {
    if (typeof text !== 'string' || text.length > 3000 || !/^CPP1:[\w-]+:[a-f0-9]{8}$/.test(text)) fail();
    const [,raw,crc] = text.split(':');
    const bytes = Uint8Array.from(atob(raw.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    if (crc32(bytes) !== parseInt(crc,16)) fail();
    const a = JSON.parse(decoder.decode(bytes));
    if (!Array.isArray(a) || a[0] !== 1 || !Array.isArray(a[1]) || !Array.isArray(a[5]) || ![0,1].includes(a[3]) || ![0,1].includes(a[5][2])) fail();
    const c = a[1], t = a[2], s = a[5];
    return validate({v:1,camera:{x:c[0],y:c[1],z:c[2],heading:c[3],tilt:c[4],fov:c[5],spatialReference:{wkid:c[6]}},
      target:t ? {longitude:t[0],latitude:t[1],z:t[2]} : null,
      orientation:a[3] ? 'portrait' : 'landscape',name:a[4],sky:{date:s[0],time:s[1],visible:!!s[2],timezone:'UTC+8'}});
  };
  const pngChunks = bytes => {
    if (!signature.every((b,i) => bytes[i] === b)) return [];
    const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), result = [];
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = view.getUint32(offset), end = offset + 12 + size;
      if (end > bytes.length) throw new Error('PNG 文件不完整。');
      const type = String.fromCharCode(...bytes.subarray(offset+4,offset+8));
      result.push({offset,size,end,type}); offset = end;
      if (type === 'IEND') return result;
    }
    throw new Error('PNG 文件不完整。');
  };
  const embed = async (blob, text) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const iend = pngChunks(bytes).find(c => c.type === 'IEND');
    if (!iend) fail();
    const body = encoder.encode(keyword+'\0'+text), chunk = new Uint8Array(body.length+12);
    const view = new DataView(chunk.buffer); view.setUint32(0,body.length);
    chunk.set(encoder.encode('tEXt'),4); chunk.set(body,8);
    view.setUint32(chunk.length-4,crc32(chunk.subarray(4,chunk.length-4)));
    return new Blob([bytes.subarray(0,iend.offset),chunk,bytes.subarray(iend.offset)],{type:'image/png'});
  };
  const metadata = bytes => {
    for (const c of pngChunks(bytes)) {
      if (c.type !== 'tEXt' || c.size > 4096) continue;
      const body = bytes.subarray(c.offset+8,c.end-4);
      const prefix = encoder.encode(keyword+'\0');
      if (!prefix.every((b,i) => body[i] === b)) continue;
      const stored = new DataView(bytes.buffer,bytes.byteOffset+c.end-4,4).getUint32(0);
      if (stored !== crc32(bytes.subarray(c.offset+4,c.end-4))) fail();
      return unpack(decoder.decode(body.subarray(prefix.length)));
    }
    return null;
  };
  const loadImage = src => new Promise((resolve,reject) => {
    const image = new Image(); image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法读取图片，请选择 PNG、JPG 或 WebP。')); image.src = src;
  });
  const read = async file => {
    if (!file || file.size > 40*1024*1024) throw new Error('请选择不超过 40 MB 的分享图片。');
    let metadataError;
    try { const data = metadata(new Uint8Array(await file.arrayBuffer())); if (data) return {data,via:'内嵌数据'}; }
    catch (e) { metadataError = e; }
    const url = URL.createObjectURL(file);
    try {
      const image = await loadImage(url);
      if (image.width * image.height > 60e6) throw new Error('图片尺寸过大，请使用原始分享图。');
      // Scan footer first for speed; whole image also supports screenshots with margins.
      for (const footer of [true,false]) {
        const scale = Math.min(1,2400 / Math.max(image.width,image.height));
        const canvas = document.createElement('canvas');
        const sy = footer ? Math.floor(image.height*0.55) : 0;
        canvas.width = Math.round(image.width*scale); canvas.height = Math.round((image.height-sy)*scale);
        const ctx = canvas.getContext('2d',{willReadFrequently:true});
        ctx.drawImage(image,0,sy,image.width,image.height-sy,0,0,canvas.width,canvas.height);
        const pixels = ctx.getImageData(0,0,canvas.width,canvas.height);
        const qr = jsQR(pixels.data,pixels.width,pixels.height,{inversionAttempts:'attemptBoth'});
        if (qr?.data?.startsWith('CPP1:')) return {data:unpack(qr.data),via:'二维码'};
      }
      if (metadataError) throw metadataError;
      throw new Error('未找到机位数据或可识别的二维码，请使用完整分享图或原有 JSON。');
    } finally { URL.revokeObjectURL(url); }
  };
  const drawBrand = (ctx,x,y,scale=1) => {
    ctx.save(); ctx.translate(x,y); ctx.scale(scale,scale);
    ctx.strokeStyle='#123f43'; ctx.lineWidth=5; ctx.lineCap='round';
    const corner=(x1,y1,x2,y2,x3,y3)=>{ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.lineTo(x3,y3);ctx.stroke();};
    corner(0,13,0,0,13,0);corner(47,0,60,0,60,13);corner(0,47,0,60,13,60);corner(47,60,60,60,60,47);
    ctx.fillStyle='#123f43';ctx.fillRect(11,35,9,18);ctx.fillRect(24,25,10,28);ctx.fillRect(38,32,11,21);
    ctx.fillStyle='#efa45e';ctx.beginPath();ctx.arc(41,17,7,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#123f43';ctx.font='600 25px "Microsoft YaHei",Arial,sans-serif';ctx.textBaseline='middle';ctx.fillText('城市摆拍',72,31);
    ctx.restore();
  };
  const compose = async (dataUrl,data,skySvg=null,includeQr=false) => {
    const text = pack(data), image = await loadImage(dataUrl);
    const portrait = data.orientation === 'portrait';
    const width = portrait ? 1200 : 1800, photoHeight = portrait ? 1800 : 1200;
    if (Math.abs(image.width/image.height - width/photoHeight) > 0.002) throw new Error('场景未返回正确的横竖画幅，请重新生成。');
    let qr=null,modules=0,unit=0,qrSize=0;
    if(includeQr) {
      qr=qrcode(0,'M'); qr.addData(text,'Byte'); qr.make();
      modules=qr.getModuleCount(); unit=Math.max(4,Math.floor(330/(modules+8))); qrSize=(modules+8)*unit;
    }
    const pad = 48, footer = Math.max(data.name ? 360 : 300,qrSize+104);
    const canvas = document.createElement('canvas'); canvas.width=width; canvas.height=photoHeight+footer;
    const ctx = canvas.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,width,canvas.height);
    ctx.drawImage(image,0,0,width,photoHeight);
    if (skySvg) {
      const url=URL.createObjectURL(new Blob([skySvg],{type:'image/svg+xml'}));
      try { ctx.drawImage(await loadImage(url),0,0,width,photoHeight); }
      finally { URL.revokeObjectURL(url); }
    }
    const xq = includeQr ? width-pad-qrSize : width-pad, yq = photoHeight+32;
    if(includeQr) {
      ctx.fillStyle='#111';
      for(let row=0;row<modules;row++) for(let col=0;col<modules;col++)
        if(qr.isDark(row,col)) ctx.fillRect(xq+(col+4)*unit,yq+(row+4)*unit,unit,unit);
    }
    const maxTextWidth = includeQr ? xq-pad-24 : width-pad*2;
    const line = (value,y,size,color='#222',bold=false) => {
      ctx.fillStyle=color; ctx.font=`${bold?'600':'400'} ${size}px "Microsoft YaHei",Arial,sans-serif`;
      let label=value;
      while(ctx.measureText(label).width>maxTextWidth && label.length>1) label=label.slice(0,-2)+'…';
      ctx.fillText(label,pad,y);
    };
    let y=photoHeight+60;
    if(data.name) { line(data.name,y+6,44,'#111',true); y+=62; }
    line(`海拔 ${data.camera.z.toFixed(1)} m`,y,30); y+=46;
    const focal=focalFromFov(data.camera.fov);
    line(`焦距 ${Number(focal.toFixed(1))} mm · 全画幅 · ${portrait?'竖拍 2:3':'横拍 3:2'}`,y,portrait?25:30); y+=46;
    line(`日月模拟 ${data.sky.date} ${data.sky.time} · UTC+8`,y,portrait?23:28);
    drawBrand(ctx,pad,photoHeight+footer-86,0.58);
    line('powered by 小红书©城芝士',photoHeight+footer-27,21,'#777');
    if(includeQr) {
      ctx.fillStyle='#777'; ctx.font='22px "Microsoft YaHei",Arial,sans-serif'; ctx.textAlign='center';
      ctx.fillText('拖入插件恢复机位',xq+qrSize/2,yq+qrSize+30); ctx.textAlign='left';
    }
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('图片生成失败。')),'image/png'));
    return {blob:await embed(blob,text),width,height:canvas.height};
  };
  globalThis.cityShareImage={fovFromFocal,focalFromFov,validate,pack,unpack,embed,metadata,read,compose};
})();
