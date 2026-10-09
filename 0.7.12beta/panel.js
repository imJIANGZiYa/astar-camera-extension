(() => {
  const CHANNEL = "astar-camera-v1";
  const STORAGE_KEY = "astarCameraPresets";
  const FORCE_KEY = "astarRepairModelDisplay";
  const POSITION_KEY = "cityCameraPanelPosition";
  let host, root, currentCamera = null;
  let selectedTarget = null;
  let locating = false;
  let requestNumber = 0;
  const pending = new Map();
  let orbitTimer = null;
  let headingValue = 0;
  let headingDragBase = 0;
  let handshakeTimer = null;
  let sharedCameraOpened = false;
  let celestialTimer = null, celestialPlayTimer = null, lastCelestial = null;
  const sceneWindow = () => {
    if (location.pathname.startsWith("/city-scene/")) return window;
    const frame = document.querySelector('iframe.city-scene-frame, iframe[src*="/city-scene/"]');
    return frame?.contentWindow || null;
  };
  const lensValues = [14, 24, 35, 50, 85, 200, 400].map(mm => String(cityShareImage.fovFromFocal(mm)));
  const normalizeHeading = (heading) => (heading % 360 + 360) % 360;
  const showHeading = () => {
    root.querySelector("#heading-value").textContent = `${Number(headingValue.toFixed(1))}°`;
  };

  const askProbe = (type, payload) => new Promise((resolve, reject) => {
    const requestId = ++requestNumber;
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("操作超时。请等待页面加载完成后刷新。"));
    }, type === "pick" ? 60000 : ["screenshot", "shareScreenshot"].includes(type) ? 45000 : 10000);
    pending.set(requestId, { resolve, reject, timeout });
    const recipient = sceneWindow();
    if (!recipient) {
      clearTimeout(timeout);
      pending.delete(requestId);
      reject(new Error("三维场景尚未加载，请稍后重试。"));
      return;
    }
    recipient.postMessage({
      channel: CHANNEL, from: "panel", type, requestId,
      camera: type === "goto" ? payload.camera || payload : undefined,
      target: type === "goto" ? payload.target : undefined,
      options: type === "orbit" || type === "step" || ["screenshot", "shareScreenshot"].includes(type) ? payload : undefined,
      enabled: type === "force" || type === "annotations" ? payload : undefined,
      celestial: type === "celestial" ? payload : undefined,
      fov: type === "lens" ? payload : undefined
    }, location.origin);
  });

  const setupExport = () => {
    const annotations = root.querySelector("#hide-annotations");
    annotations.onchange = async () => {
      const hidden = annotations.checked;
      annotations.disabled = true;
      try {
        const result = await askProbe("annotations", hidden);
        status(hidden ? `已关闭注记，处理 ${result.count} 个图层或标记。` : "已恢复注记原有显示状态。");
      } catch (error) { annotations.checked = !hidden; status(error.message); }
      finally { annotations.disabled = false; }
    };
    const section = document.createElement("details");
    section.innerHTML = `<summary>图片与视频导出</summary><div class="section-content">
      <div class="field"><label>分辨率</label><select id="export-size"><option value="1920,1080">1920 × 1080</option><option value="2560,1440">2560 × 1440</option><option value="3840,2160">3840 × 2160</option></select></div>
      <button id="export-image" type="button">导出 PNG 图片</button>
      <div class="hint">视频从起点机位移动到终点机位。仅导出三维场景，不包含工具栏。</div>
      <button id="export-start" type="button">设为视频起点</button><button id="export-end" type="button">设为视频终点</button>
      <div id="export-points" class="hint">尚未设置起点和终点</div>
      <div class="field"><label>时长（秒）</label><input id="export-duration" type="number" min="1" max="30" value="5"></div>
      <div class="field"><label>帧率</label><select id="export-fps"><option>24</option><option>30</option><option>15</option></select></div>
      <div class="field"><label>输出类型</label><select id="export-kind"><option value="frames">PNG 帧序列</option><option value="video">WebM 视频</option></select></div>
      <div class="hint">PNG 适合高清后期；WebM 方便直接播放，实际时长可能受浏览器编码调度影响。</div>
      <button id="export-video" type="button">开始导出</button><button id="export-cancel" type="button" disabled>取消导出</button>
      <div id="export-progress" class="hint" role="status"></div></div>`;
    root.querySelector("#notice").before(section);
    let start = null, end = null, busy = false, cancelled = false;
    const progress = text => root.querySelector("#export-progress").textContent = text;
    const size = () => {
      const [width, height] = root.querySelector("#export-size").value.split(",").map(Number);
      return { width, height };
    };
    const download = (blob, name) => {
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
    const lock = enabled => {
      busy = enabled; cancelled = false;
      for (const el of root.querySelectorAll("button,input,select,textarea")) {
        if (enabled) { el.dataset.exportDisabled = String(el.disabled); el.disabled = true; }
        else if (el.dataset.exportDisabled != null) {
          el.disabled = el.dataset.exportDisabled === "true"; delete el.dataset.exportDisabled;
        }
      }
      root.querySelector("#export-cancel").disabled = !enabled;
    };
    for (const point of ["start", "end"]) root.querySelector(`#export-${point}`).onclick = async () => {
      try {
        const result = await askProbe("read");
        if (point === "start") start = result.camera; else end = result.camera;
        root.querySelector("#export-points").textContent = `起点：${start ? "已设置" : "未设置"}；终点：${end ? "已设置" : "未设置"}`;
      } catch (error) { progress(error.message); }
    };
    root.querySelector("#export-cancel").onclick = () => { cancelled = true; progress("正在取消，等待当前帧完成…"); };
    root.querySelector("#export-image").onclick = async () => {
      if (busy) return;
      lock(true);
      try {
        progress("正在生成高清图片…");
        const shot = await askProbe("screenshot", size());
        if (!cancelled) { download(await (await fetch(shot.dataUrl)).blob(), `城市摆拍-${stamp()}.png`); progress("图片已导出。"); }
        else progress("已取消。");
      } catch (error) { progress(`导出失败：${error.message}`); }
      finally { lock(false); }
    };
    root.querySelector("#export-video").onclick = async () => {
      if (busy) return;
      if (!start || !end) { progress("请先设置视频起点和终点。"); return; }
      const duration = Number(root.querySelector("#export-duration").value);
      const fps = Number(root.querySelector("#export-fps").value);
      if (!Number.isFinite(duration) || duration < 1 || duration > 30) { progress("时长须在 1 至 30 秒之间。"); return; }
      const kind = root.querySelector("#export-kind").value, resolution = size();
      let directory, original, recorder, stream, recordingDone, recorderError;
      const chunks = [];
      let mime;
      if (kind === "video") {
        mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
          .find(type => window.MediaRecorder?.isTypeSupported(type));
        if (!mime) { progress("当前浏览器不支持 WebM，请选择 PNG 帧序列。"); return; }
      }
      lock(true);
      try {
        if (kind === "frames") {
          if (!window.showDirectoryPicker) throw new Error("请使用支持文件夹选择的 Chrome 或 Edge。");
          directory = await window.showDirectoryPicker({ mode: "readwrite" });
          directory = await directory.getDirectoryHandle(`城市摆拍-${stamp()}`, { create: true });
        }
        original = await askProbe("read");
        const canvas = document.createElement("canvas");
        canvas.width = resolution.width; canvas.height = resolution.height;
        const ctx = canvas.getContext("2d");
        const total = Math.max(2, Math.round(duration * fps));
        const delta = ((end.heading - start.heading + 540) % 360) - 180;
        if (kind === "video") {
          stream = canvas.captureStream(fps);
          recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16000000 });
          recordingDone = new Promise(resolve => { recorder.onstop = resolve; });
          recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
          recorder.onerror = event => { recorderError = event.error || new Error("视频编码失败。"); };
        }
        for (let i = 0; i < total && !cancelled; i++) {
          if (recorderError) throw recorderError;
          const t = i / (total - 1), camera = { ...start };
          for (const key of ["x", "y", "z", "tilt", "fov"])
            camera[key] = start[key] + (end[key] - start[key]) * t;
          camera.heading = (start.heading + delta * t + 360) % 360;
          await askProbe("goto", { camera });
          const shot = await askProbe("screenshot", resolution);
          if (cancelled) break;
          const blob = await (await fetch(shot.dataUrl)).blob();
          if (kind === "frames") {
            const file = await directory.getFileHandle(`frame_${String(i + 1).padStart(5, "0")}.png`, { create: true });
            const writable = await file.createWritable();
            try { await writable.write(blob); } finally { await writable.close(); }
          } else {
            const bitmap = await createImageBitmap(blob);
            ctx.drawImage(bitmap, 0, 0); bitmap.close();
            const resume = new Promise(resolve => recorder.addEventListener(
              recorder.state === "inactive" ? "start" : "resume", resolve, { once: true }));
            if (recorder.state === "inactive") recorder.start(); else recorder.resume();
            await resume;
            stream.getVideoTracks()[0]?.requestFrame?.();
            await new Promise(resolve => setTimeout(resolve, 1000 / fps));
            const paused = new Promise(resolve => recorder.addEventListener("pause", resolve, { once: true }));
            recorder.pause();
            await paused;
          }
          progress(`已导出 ${i + 1}/${total} 帧（${Math.round((i + 1) / total * 100)}%）`);
        }
        if (recorder && recorder.state !== "inactive") {
          recorder.stop(); await recordingDone;
          if (recorderError) throw recorderError;
          if (!cancelled) download(new Blob(chunks, { type: mime }), `城市摆拍-${stamp()}.webm`);
        }
        if (kind === "frames" && !cancelled) {
          const file = await directory.getFileHandle("说明.txt", { create: true });
          const writable = await file.createWritable();
          try { await writable.write(`PNG 帧序列：${total} 帧，${fps} fps，${duration} 秒。\n请按帧号顺序导入剪辑软件，并将序列帧率设为 ${fps}。`); }
          finally { await writable.close(); }
        }
        progress(cancelled ? "已取消；已写入的 PNG 帧保留在文件夹中。" : `导出完成：${total} 帧，${fps} 帧/秒。`);
      } catch (error) {
        progress(error.name === "AbortError" ? "已取消文件夹选择。" : `导出失败：${error.message}`);
      } finally {
        if (recorder && recorder.state !== "inactive") recorder.stop();
        stream?.getTracks().forEach(track => track.stop());
        if (original) {
          try { const restored = await askProbe("goto", original); showCamera(restored.camera); showTarget(original.target); }
          catch (error) { progress(`导出结束，但机位恢复失败：${error.message}`); }
        }
        lock(false);
      }
    };
  };

  const format = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : "—";
  const status = (message) => { if (root) root.querySelector("#status").textContent = message; };
  const showCamera = (camera) => {
    currentCamera = camera;
    root.querySelector("#values").textContent =
      `相机高度 ${format(camera.z, 2)} m\n` +
      `朝向 ${format(camera.heading, 2)}°  机位角度 ${format(camera.tilt, 2)}°\n` +
      `镜头视角 ${format(camera.fov, 1)}°`;
  };
  const showTarget = (target) => {
    selectedTarget = target;
    if (root.querySelector("#celestial-date")) scheduleCelestialUpdate();
    root.querySelector("#target").textContent = target
      ? "已选定中心位置"
      : "尚未点选中心";
  };
  const options = () => ({
    heading: headingValue,
    height: Number(root.querySelector("#height").value),
    tilt: Number(root.querySelector("#tilt").value),
    fov: Number(root.querySelector("#fov").value)
  });
  const applyOrbit = async () => {
    if (!selectedTarget) { status("请先点击“点选中心”，再点击场景中的位置。"); return; }
    try {
      const result = await askProbe("orbit", options());
      showCamera(result.camera);
      showTarget(result.target);
      status("机位高度、朝向、俯仰角和镜头视角已应用。");
    } catch (error) { status(error.message); }
  };
  const fillOrbit = (result) => {
    showTarget(result.target);
    headingValue = normalizeHeading(result.heading);
    headingDragBase = headingValue;
    root.querySelector("#heading").value = 0;
    showHeading();
    root.querySelector("#height").value = result.height.toFixed(1);
    root.querySelector("#tilt").value = result.tilt.toFixed(1);
    root.querySelector("#tilt-preset").value = ["60", "90", "110"].find(
      (value) => Number(value) === Math.round(result.tilt)
    ) || "";
    const fov = Number.isFinite(result.fov) ? result.fov : result.camera?.fov;
    if (Number.isFinite(fov)) {
      root.querySelector("#fov").value = fov.toFixed(4);
      root.querySelector("#fov-preset").value = lensValues.find(
        (value) => Math.abs(Number(value) - fov) < 0.001
      ) || "";
    }
    showCamera(result.camera);
  };
  const applyLens = async () => {
    const fov = Number(root.querySelector("#fov").value);
    try {
      const result = await askProbe("lens", fov);
      showCamera(result.camera);
      status("镜头视角已设为 " + result.fov.toFixed(4) + "°。");
    } catch (error) { status(error.message); }
  };
  const validCamera = (camera) => camera &&
    [camera.x, camera.y, camera.z, camera.heading, camera.tilt].every(Number.isFinite);
  const decodeCamera = async (text) => {
    const value = text.trim();
    if (!value) throw new Error("请先粘贴分享链接或机位 JSON。");
    let shared;
    if (value.startsWith("{")) {
      const parsed = JSON.parse(value);
      shared = {
        camera: cityCameraCodec.minimalCamera(parsed.camera || parsed),
        target: cityCameraCodec.minimalTarget(parsed.target)
      };
    } else {
      const url = new URL(value);
      const params = new URLSearchParams(url.hash.split("?")[1] || "");
      const encrypted = params.get("astarCamera2");
      if (encrypted) {
        shared = await cityCameraCodec.decrypt(encrypted);
      } else {
        const encoded = params.get("astarCamera");
        if (!encoded) throw new Error("链接中没有机位参数。");
        shared = {
          camera: cityCameraCodec.minimalCamera(JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")))),
          target: null
        };
      }
    }
    if (!validCamera(shared.camera)) throw new Error("机位参数不完整或格式不正确。");
    return shared;
  };
  const hasSharedCamera = () => /(?:\?|&)astarCamera(?:2)?=/.test(location.hash);
  const loadPresets = async () => (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
  const renderPresets = async () => {
    const list = root.querySelector("#presets");
    list.replaceChildren();
    for (const preset of await loadPresets()) {
      const row = document.createElement("div");
      row.className = "preset";
      const label = document.createElement("span");
      label.textContent = preset.name;
      const go = document.createElement("button");
      go.textContent = "到达";
      go.onclick = async () => {
        try {
          const result = await askProbe("goto", {
            camera: cityCameraCodec.minimalCamera(preset.camera),
            target: cityCameraCodec.minimalTarget(preset.target)
          });
          showCamera(result.camera);
          if (result.target) fillOrbit(result);
          else showTarget(null);
          status(`已恢复：${preset.name}`);
        }
        catch (error) { status(error.message); }
      };
      const remove = document.createElement("button");
      remove.textContent = "删除";
      remove.onclick = async () => {
        const presets = (await loadPresets()).filter((item) => item.id !== preset.id);
        await chrome.storage.local.set({ [STORAGE_KEY]: presets });
        await renderPresets();
      };
      row.append(label, go, remove);
      list.append(row);
    }
  };

  const compass = (degreesValue) => {
    const names = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
    return names[Math.round(normalizeHeading(degreesValue) / 45) % 8];
  };

  const timeText = (minutes) => {
    const value = ((Number(minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  };

  const updateCelestial = async () => {
    const info = root.querySelector("#celestial-status");
    if (!selectedTarget) {
      info.textContent = "请先点选中心位置。";
      root.querySelector("#sun-result").textContent = "等待计算";
      root.querySelector("#moon-result").textContent = "等待计算";
      root.querySelector("#moon-light").textContent = "";
      await askProbe("clearCelestial").catch(() => {});
      return;
    }
    try {
      const dateText = root.querySelector("#celestial-date").value;
      const time = root.querySelector("#celestial-exact-time").value ||
        `${timeText(root.querySelector("#celestial-time").value)}:00`;
      root.querySelector("#celestial-time-label").textContent = time;
      lastCelestial = cityCelestial.calculate(
        dateText, time, selectedTarget.latitude, selectedTarget.longitude
      );
      root.querySelector("#sun-result").textContent =
        `${Math.round(lastCelestial.sun.azimuth)}° ${compass(lastCelestial.sun.azimuth)}　仰角 ${lastCelestial.sun.altitude.toFixed(1)}°`;
      root.querySelector("#moon-result").textContent =
        `${Math.round(lastCelestial.moon.azimuth)}° ${compass(lastCelestial.moon.azimuth)}　仰角 ${lastCelestial.moon.altitude.toFixed(1)}°`;
      root.querySelector("#moon-light").textContent = `照明 ${Math.round(lastCelestial.moon.illumination)}%`;
      info.textContent = `日出 ${lastCelestial.events.sunrise} · 日落 ${lastCelestial.events.sunset} · 月升 ${lastCelestial.events.moonrise} · 月落 ${lastCelestial.events.moonset}（轨迹不计算建筑遮挡）`;
      if (root.querySelector("#celestial-visible").checked) {
        await askProbe("celestial", lastCelestial);
      }
    } catch (error) {
      info.textContent = error.message;
    }
  };

  const scheduleCelestialUpdate = () => {
    clearTimeout(celestialTimer);
    celestialTimer = setTimeout(updateCelestial, 80);
  };

  const initializeShanghaiTime = () => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date()).reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
    root.querySelector("#celestial-date").value = `${parts.year}-${parts.month}-${parts.day}`;
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    root.querySelector("#celestial-time").value = String(minutes);
    root.querySelector("#celestial-exact-time").value = `${timeText(minutes)}:00`;
    root.querySelector("#celestial-time-label").textContent = `${timeText(minutes)}:00`;
  };



  const setupImageSharing = () => {
    const section = document.createElement('details');
    section.innerHTML = `<summary>图片分享机位</summary><div class="section-content">
      <div class="field"><label>画幅</label><select id="share-orientation"><option value="landscape">横拍 3:2</option><option value="portrait">竖拍 2:3</option></select></div>
      <div class="field"><label>机位名称</label><input id="share-name" maxlength="40" placeholder="选填，不填则隐藏"></div>
      <label class="switch-row"><input id="share-qr" type="checkbox"> 生成二维码恢复信息（选填）</label>
      <div class="hint">（分享取景为主，功能待优化）默认不生成二维码；原始 PNG 仍可通过内嵌数据恢复。</div>
      <div class="hint">全画幅取景；下方另加白色信息区。保存海拔、镜头参数和日月模拟时间。</div>
      <div class="actions"><button id="share-preview" type="button">生成分享预览</button><button id="share-download" type="button" disabled>下载 PNG</button></div>
      <img id="share-image-preview" alt="分享图预览" hidden style="width:100%;height:auto;margin-top:10px;border:1px solid #ddd">
      <div id="share-image-status" class="hint" role="status"></div>
      <div id="share-drop" tabindex="0" role="button" aria-label="选择或拖入分享图恢复机位" style="padding:16px 8px;margin-top:10px;border:1px dashed #608f90;border-radius:8px;text-align:center;cursor:pointer">拖入分享图恢复机位，或点击选图</div>
      <input id="share-file" type="file" accept="image/png,image/jpeg,image/webp" hidden>
      <div class="hint">PNG 原图优先读取内嵌数据；只有勾选生成二维码时，压缩或转格式后才会尝试二维码恢复。</div>
    </div>`;
    root.querySelector('#notice').before(section);
    const el = id => root.querySelector('#'+id);
    let generated = null, previewUrl = null, busy = false;
    const message = text => el('share-image-status').textContent = text;
    const skyState = () => ({date:el('celestial-date').value,time:el('celestial-exact-time').value,
      timezone:'UTC+8',visible:el('celestial-visible').checked});
    const pauseSky = () => {
      clearInterval(celestialPlayTimer); celestialPlayTimer=null; clearTimeout(celestialTimer);
      el('celestial-play').textContent='播放一天';
    };
    const invalidate = () => {
      generated=null; el('share-download').disabled=true; el('share-image-preview').hidden=true;
      if(previewUrl) URL.revokeObjectURL(previewUrl); previewUrl=null;
    };
    const lock = active => {
      busy=active;
      for(const item of root.querySelectorAll('button,input,select,textarea')) {
        if(active) { item.dataset.shareDisabled=String(item.disabled); item.disabled=true; }
        else if(item.dataset.shareDisabled!=null) {
          item.disabled=item.dataset.shareDisabled==='true'; delete item.dataset.shareDisabled;
        }
      }
      el('share-download').disabled=active || !generated;
    };
    el('share-orientation').onchange=invalidate; el('share-name').oninput=invalidate; el('share-qr').onchange=invalidate;
    el('share-preview').onclick=async()=>{
      if(busy) return;
      pauseSky(); invalidate(); lock(true);
      try {
        message('正在按所选画幅生成分享图…');
        const orientation=el('share-orientation').value, name=el('share-name').value.trim(), sky=skyState();
        cityCelestial.parseShanghaiTime(sky.date,sky.time);
        const shot=await askProbe('shareScreenshot',{orientation});
        const data={v:1,camera:cityCameraCodec.minimalCamera(shot.camera),target:cityCameraCodec.minimalTarget(shot.target),orientation,name,sky};
        generated=await cityShareImage.compose(shot.dataUrl,data,sky.visible ? shot.skySvg : null,el('share-qr').checked);
        previewUrl=URL.createObjectURL(generated.blob);
        el('share-image-preview').src=previewUrl; el('share-image-preview').hidden=false;
        message(`预览已生成（${generated.width} × ${generated.height}），下载内容与预览一致。调整机位或时间后请重新生成。`);
      } catch(error) { message(`生成失败：${error.message}`); }
      finally { lock(false); }
    };
    el('share-download').onclick=()=>{
      if(!generated || busy) return;
      const a=document.createElement('a'); a.href=previewUrl;
      a.download=`城市摆拍-机位分享-${Date.now()}.png`; a.click(); message('已下载，可把这张图拖入插件恢复机位。');
    };
    const restore=async file=>{
      if(busy || el('share-preview').disabled || !file) return;
      pauseSky(); lock(true);
      try {
        message('正在读取图片中的机位信息…');
        const {data,via}=await cityShareImage.read(file);
        const result=await askProbe('goto',{camera:data.camera,target:data.target});
        // Fill all fields even when a shared camera did not have an orbit target.
        fillOrbit({...result,heading:result.camera.heading,height:result.camera.z,tilt:result.camera.tilt});
        el('share-orientation').value=data.orientation; el('share-name').value=data.name;
        el('name').value=data.name;
        el('celestial-date').value=data.sky.date; el('celestial-exact-time').value=data.sky.time;
        const parts=data.sky.time.split(':').map(Number);
        el('celestial-time').value=parts[0]*60+parts[1]; el('celestial-time-label').textContent=data.sky.time;
        el('celestial-visible').checked=data.sky.visible;
        await updateCelestial(); invalidate();
        status('已恢复图片机位、画幅和日月模拟时间。');
        message(`已通过${via}恢复。点击“生成分享预览”可查看保存的横竖构图。`);
      } catch(error) { message(`恢复失败：${error.message}`); }
      finally { lock(false); }
    };
    const drop=el('share-drop');
    drop.onclick=()=>{if(!busy && !el('share-file').disabled) el('share-file').click();};
    drop.onkeydown=e=>{if(e.key==='Enter'||e.key===' ') {e.preventDefault();drop.click();}};
    el('share-file').onchange=async e=>{const file=e.target.files[0];e.target.value='';await restore(file);};
    // The top document can receive drops on the panel or scene iframe surface.
    const installDrop = doc => {
      doc.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files')) {e.preventDefault();e.dataTransfer.dropEffect='copy';}},true);
      doc.addEventListener('drop',e=>{
        const files=e.dataTransfer?.files;
        if(!files?.length) return;
        e.preventDefault();e.stopPropagation();section.open=true;
        if(files.length!==1) {message('请每次拖入一张分享图。');return;}
        restore(files[0]);
      },true);
    };
    const dropDocuments=new WeakSet();
    const connectDrops=()=>{
      let sceneDocument;
      try { sceneDocument=sceneWindow()?.document; } catch (_) { /* Frame may be navigating. */ }
      for(const doc of [document,sceneDocument]) {
        if(doc && !dropDocuments.has(doc)) {installDrop(doc);dropDocuments.add(doc);}
      }
    };
    connectDrops(); setInterval(connectDrops,2000);
    window.addEventListener('pagehide',()=>{if(previewUrl) URL.revokeObjectURL(previewUrl);},{once:true});
  };

  const mount = () => {
    if (host) return;
    host = document.createElement("div");
    host.id = "astar-camera-extension";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { position: fixed; top: 76px; right: 16px; z-index: 2147483647;
          width: min(344px, calc(100vw - 24px)); font: 13px/1.45 Arial, sans-serif;
          color: #153142; filter: drop-shadow(0 18px 38px #12364942); }
        * { box-sizing: border-box; }
        #box { position: relative; overflow: hidden;
          background: linear-gradient(145deg, #f6ffffcc, #eaf5fbad 52%, #e7f1f8c2);
          border: 1px solid #ffffffd9; border-radius: 20px;
          box-shadow: inset 0 1px 0 #fff, inset 0 -1px 0 #86aeb538,
            0 16px 42px #0b385040, 0 3px 12px #0c6f7330;
          backdrop-filter: blur(24px) saturate(155%); -webkit-backdrop-filter: blur(24px) saturate(155%); }
        #box::before { content: ''; position: absolute; inset: 0; pointer-events: none;
          background: radial-gradient(circle at 16% 0%, #ffffffc7 0 8%, transparent 34%),
            linear-gradient(110deg, transparent 12%, #ffffff48 43%, transparent 68%); }
        #header { display: flex; align-items: center; gap: 8px; padding: 11px 13px;
          position: relative; background: linear-gradient(125deg, #0a6677db, #138c87c7 58%, #5bb8aed1);
          border-bottom: 1px solid #ffffff75; color: #fff; cursor: grab;
          user-select: none; touch-action: none; }
        #header:active { cursor: grabbing; }
        #box.is-dragging { box-shadow: inset 0 1px 0 #fff, 0 22px 54px #073b4f59; }
        h2 { flex: 1; margin: 0; font-size: 16px; font-weight: 700; letter-spacing: .3px; }
        h2 small { margin-left: 5px; padding: 2px 6px; border: 1px solid #ffffff61; border-radius: 999px;
          background: #d6fff26b; color: #ecffff; font-size: 10px; vertical-align: middle; }
        button { cursor: pointer; min-height: 31px; border: 1px solid #b9cbd5;
          border-radius: 10px; padding: 5px 9px; background: #ffffffb8; color: #17384a;
          font: inherit; white-space: nowrap; }
        button:hover { background: #ffffffeb; border-color: #6fb7bd; box-shadow: 0 4px 12px #2b7f8426; }
        button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible,
        summary:focus-visible { outline: 2px solid #17a99c; outline-offset: 2px; }
        #collapse-panel { min-width: 30px; min-height: 28px; padding: 2px 7px;
          border-color: #ffffff8f; background: #ffffff24; color: #fff; font-size: 18px; }
        #collapse-panel:hover { background: #ffffff42; }
        #body { max-height: min(70vh, 660px); overflow-y: auto; overscroll-behavior: contain; }
        #box.is-collapsed #body { display: none; }
        #box.is-collapsed #collapse-panel { transform: rotate(180deg); }
        #status { padding: 8px 13px; min-height: 34px; border-bottom: 1px solid #dce7eb;
          background: #e0f7f1a8; color: #225a5b; font-size: 12px; }
        details { position: relative; border-bottom: 1px solid #ffffffbf; background: #ffffff73; }
        details:last-child { border-bottom: 0; }
        summary { display: flex; align-items: center; gap: 8px; min-height: 39px;
          padding: 9px 13px; cursor: pointer; font-weight: 700; list-style: none; }
        summary::-webkit-details-marker { display: none; }
        summary::after { content: '⌄'; margin-left: auto; color: #597987; font-size: 17px;
          line-height: 12px; transition: transform .15s; }
        details[open] > summary::after { transform: rotate(180deg); }
        .section-content { padding: 0 13px 12px; }
        .hint, #force-status { margin: 3px 0 8px; color: #647b87; font-size: 12px; }
        .field { display: flex; align-items: center; gap: 7px; margin: 8px 0; }
        .field label { flex: 0 0 77px; color: #425b69; }
        input, select, textarea { min-width: 0; border: 1px solid #bdcdd6; border-radius: 6px;
          padding: 6px 8px; background: #ffffffb8; color: #17384a; font: inherit;
          box-shadow: inset 0 1px 2px #294f5b12; }
        input[type=number] { width: 92px; flex: 1; }
        input[type=range] { flex: 1; padding: 0; accent-color: #0c9d93; }
        input[type=checkbox] { accent-color: #0c9d93; }
        select { flex: 1; width: 128px; }
        #tilt, #fov { flex: 0 0 56px; width: 56px; }
        #heading-value { min-width: 45px; text-align: right; font-variant-numeric: tabular-nums; }
        #target, #values { margin: 9px 0; padding: 8px 9px; border-radius: 6px;
          border: 1px solid #ffffffbd; background: #edf8fac2; color: #3b5664; }
        #values { white-space: pre-wrap; font-size: 12px; line-height: 1.55; }
        .actions, #save { display: flex; gap: 6px; margin: 8px 0 0; }
        .actions button { flex: 1; }
        .primary { border-color: #0b9489b8; background: linear-gradient(135deg, #13aa9d, #087f78); color: #fff; }
        .primary:hover { border-color: #087b73; background: linear-gradient(135deg, #20b9aa, #087f78); }
        .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px;
          width: 154px; margin: 8px auto 0; }
        .steps button:first-child { grid-column: 2; }
        .steps button:nth-child(2) { grid-column: 2; grid-row: 3; }
        .steps button:nth-child(3) { grid-column: 1; grid-row: 2; }
        .steps button:nth-child(4) { grid-column: 3; grid-row: 2; }
        #import-text { display: block; width: 100%; min-height: 48px; margin: 9px 0 6px;
          resize: vertical; }
        #save input { flex: 1; }
        .preset { display: flex; align-items: center; gap: 4px; margin-top: 6px; }
        .preset span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .switch-row { display: flex; align-items: center; gap: 6px; cursor: pointer; }
        #force-status { margin: 8px 0 0; }
        #notice { padding: 10px 13px 12px; border-top: 1px solid #dce7eb;
          background: #eef6f8a6; color: #6a7d87; font-size: 11px; line-height: 1.6; }
        #notice strong { color: #405b68; font-weight: 600; }
        :host { filter: none; }
        #box { filter: drop-shadow(0 18px 38px #12364942); }
        .sky-results { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 8px 0; }
        .sky-card { min-width: 0; padding: 8px; border-radius: 8px; background: #f5f8fa; border: 1px solid #d6e2e7; }
        .sky-card.sun { background: #fff8e8; border-color: #ecd7a3; }
        .sky-card.moon { background: #f1f4fc; border-color: #d3dced; }
        .sky-card strong, .sky-card span { display: block; }
        .sky-card span { color: #4c6572; font-size: 11px; line-height: 1.5; }
        .floating-panel { position: fixed; overflow: hidden; border: 1px solid #c9d9e2; border-radius: 13px;
          background: #f7fafc; box-shadow: 0 12px 36px #0b38504d; }
        .floating-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #123c50; color: #fff; }
        .floating-head h3 { flex: 1; margin: 0; font-size: 15px; }
        .floating-head button { min-height: 27px; padding: 2px 8px; border-color: #668795; background: #ffffff12; color: #fff; }
        #celestial-dock { left: 50%; bottom: 16px; width: min(700px, calc(100vw - 740px)); min-width: 470px;
          transform: translateX(-50%); max-height: calc(100vh - 24px); overflow-y: auto; z-index: 2147483646; }
        #celestial-content { display: grid; grid-template-columns: minmax(230px, 1fr) minmax(250px, 1.1fr);
          gap: 10px 14px; padding: 11px 13px 13px; background: #fff; }
        #celestial-controls, #celestial-summary { min-width: 0; }
        #celestial-dock .field, #celestial-dock .sky-results { margin-top: 0; }
        #celestial-status { grid-column: 1 / -1; margin: 0; padding-top: 7px; color: #647b87;
          font-size: 11px; border-top: 1px solid #e0e8ec; }
        @media (max-width: 1180px) {
          #celestial-dock { left: 12px; right: 370px; width: auto; min-width: 0; transform: none; }
          #celestial-content { grid-template-columns: 1fr; }
        }
        @media (max-width: 760px) { #celestial-dock { left: 12px; right: 12px; bottom: 12px; } }
      </style>
      <div id="box">
        <div id="header"><h2>城市摆拍 <small>beta</small></h2>
          <button id="collapse-panel" type="button" aria-label="收起面板" aria-expanded="true">⌃</button></div>
        <div id="body">
          <div id="status" role="status" aria-live="polite">等待场景加载…</div>
          <details open><summary>机位调整</summary><div class="section-content">
            <div class="hint">先选中心，再设置高度与视角</div>
            <div class="actions"><button id="pick" type="button" class="primary">点选中心</button>
              <button id="locate" type="button">查看机位位置</button></div>
            <div id="target">尚未点选中心</div>
            <div class="field"><label for="height">海拔高度</label><input id="height" type="number" step="0.1" placeholder="米"></div>
            <div class="field"><label for="heading">旋转朝向</label><input id="heading" type="range" min="-30" max="30" step="0.5" value="0"><span id="heading-value">0°</span></div>
            <div class="hint">相机与中心保持 0.2 米水平距离；滑块从中点向一侧微调 30°，可反复拖动。</div>
            <div class="field"><label for="tilt-preset">机位角度</label><select id="tilt-preset">
              <option value="">自定义</option><option value="60">60° 俯视</option>
              <option value="90">90° 平视</option><option value="110">110° 上仰</option>
            </select><input id="tilt" type="number" min="0" max="150" step="1" value="90" aria-label="自定义机位角度">°</div>
            <div class="field"><label for="fov-preset">镜头视角</label><select id="fov-preset">
              <option value="">自定义</option><option value="${cityShareImage.fovFromFocal(14)}">14 mm 超广角</option>
              <option value="${cityShareImage.fovFromFocal(24)}">24 mm 广角</option><option value="${cityShareImage.fovFromFocal(35)}">35 mm</option>
              <option value="${cityShareImage.fovFromFocal(50)}">50 mm</option><option value="${cityShareImage.fovFromFocal(85)}">85 mm</option>
              <option value="${cityShareImage.fovFromFocal(200)}">200 mm 长焦</option><option value="${cityShareImage.fovFromFocal(400)}">400 mm 长焦</option>
            </select><input id="fov" type="number" min="1" max="170" step="0.1" value="55" aria-label="自定义镜头视角">°</div>
            <div class="hint">36 × 24 mm 全画幅等效焦距；右侧为对角视场角。分享预览按所选横竖画幅重新取景。</div>
            <button id="apply" type="button" class="primary">应用机位</button>
          </div></details>
          <details><summary>按距离移动</summary><div class="section-content">
            <div class="field"><label for="distance">每步距离</label><input id="distance" type="number" min="0.1" step="0.1" value="10">米</div>
            <div class="steps" aria-label="机位移动方向">
              <button type="button" data-direction="forward" aria-label="向前移动">前</button>
              <button type="button" data-direction="backward" aria-label="向后移动">后</button>
              <button type="button" data-direction="left" aria-label="向左移动">左</button>
              <button type="button" data-direction="right" aria-label="向右移动">右</button>
            </div>
          </div></details>
          <details id="experimental-section"><summary>实验功能</summary><div class="section-content">
            <div class="hint">实验功能会持续调整，使用结果以当前场景为准。</div>
            <button id="open-celestial" type="button" aria-pressed="false">日月轨迹</button>
          </div></details>
          <details><summary>当前机位与分享</summary><div class="section-content">
            <div class="actions"><button id="read" type="button">获取当前视图机位</button><button id="share" type="button" class="primary">复制分享链接</button></div>
            <div id="values">等待读取</div>
            <div class="hint">分享链接不显示明文位置；持有链接并安装扩展的人可以还原机位。</div>
            <textarea id="import-text" aria-label="分享链接或机位 JSON" placeholder="粘贴分享链接或机位 JSON"></textarea>
            <button id="import" type="button">导入并到达</button>
          </div></details>
          <details><summary>已保存的机位</summary><div class="section-content">
            <div id="save"><input id="name" aria-label="机位名称" placeholder="机位名称"><button id="save-button" type="button" class="primary">保存</button></div>
            <div id="presets"></div>
          </div></details>
          <details><summary>显示设置</summary><div class="section-content">
            <label class="switch-row"><input id="force-model" type="checkbox"> 修复模型消失 BUG</label>
            <div id="force-status"></div><label class="switch-row"><input id="hide-annotations" type="checkbox"> 关闭所有注记</label><div class="hint">隐藏名称标记、图层文字及底图注记；取消勾选恢复原状态。</div>
          </div></details>
          <div id="notice"><strong>声明：</strong>仅供交流学习，禁止二次修改、转售或商业使用。<br>© 小红书 @城芝士</div>
        </div>
      </div>
      <section id="celestial-dock" class="floating-panel" hidden aria-label="日月轨迹实验工具">
        <div class="floating-head"><h3>日月轨迹 · 实验功能</h3><button id="close-celestial" type="button">收起</button></div>
        <div id="celestial-content">
          <div id="celestial-controls">
            <div class="hint">北京时间 UTC+8 · 轨迹不计算建筑遮挡</div>
            <div class="field"><label for="celestial-date">日期</label><input id="celestial-date" type="date"></div>
            <div class="field"><label for="celestial-exact-time">精确时间</label><input id="celestial-exact-time" type="time" step="1" value="12:00:00"></div>
            <div class="field"><label for="celestial-time">分钟滑块</label><input id="celestial-time" type="range" min="0" max="1439" step="1"><span id="celestial-time-label">12:00:00</span></div>
            <label class="switch-row"><input id="celestial-visible" type="checkbox"> 在地图上显示轨迹与方向</label>
            <div class="actions"><button id="celestial-play" type="button">播放一天</button><button id="celestial-clear" type="button">清除轨迹</button></div>
          </div>
          <div id="celestial-summary"><div class="sky-results">
            <div class="sky-card sun"><strong>太阳</strong><span id="sun-result">等待计算</span></div>
            <div class="sky-card moon"><strong>月亮</strong><span id="moon-result">等待计算</span><span id="moon-light"></span></div>
          </div></div>
          <div id="celestial-status">点选中心后即可计算。场景建筑尺寸可能与实景存在偏差。</div>
        </div>
      </section>`;
    document.documentElement.append(host);
    const header = root.querySelector("#header");
    const box = root.querySelector("#box");
    const clampPosition = (left, top) => ({
      left: Math.max(8, Math.min(left, window.innerWidth - host.offsetWidth - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - Math.min(host.offsetHeight, window.innerHeight - 16) - 8))
    });
    const placePanel = (left, top) => {
      const next = clampPosition(left, top);
      host.style.left = `${next.left}px`;
      host.style.top = `${next.top}px`;
      host.style.right = "auto";
      return next;
    };
    chrome.storage.local.get(POSITION_KEY).then((saved) => {
      const position = saved[POSITION_KEY];
      if (Number.isFinite(position?.left) && Number.isFinite(position?.top)) {
        placePanel(position.left, position.top);
      }
    });
    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button, input, select, textarea, a")) return;
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      box.classList.add("is-dragging");
      header.setPointerCapture(event.pointerId);
      const move = (moveEvent) => placePanel(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
      const finish = (upEvent) => {
        header.removeEventListener("pointermove", move);
        header.removeEventListener("pointerup", finish);
        header.removeEventListener("pointercancel", finish);
        box.classList.remove("is-dragging");
        if (header.hasPointerCapture(upEvent.pointerId)) header.releasePointerCapture(upEvent.pointerId);
        const rectNow = host.getBoundingClientRect();
        chrome.storage.local.set({ [POSITION_KEY]: { left: rectNow.left, top: rectNow.top } });
      };
      header.addEventListener("pointermove", move);
      header.addEventListener("pointerup", finish);
      header.addEventListener("pointercancel", finish);
    });
    window.addEventListener("resize", () => {
      if (host.style.left) placePanel(host.offsetLeft, host.offsetTop);
    });
    root.querySelector("#collapse-panel").onclick = (event) => {
      const collapsed = root.querySelector("#box").classList.toggle("is-collapsed");
      event.currentTarget.setAttribute("aria-expanded", String(!collapsed));
      event.currentTarget.setAttribute("aria-label", collapsed ? "展开面板" : "收起面板");
    };
    root.querySelector("#read").onclick = async () => {
      try {
        const result = await askProbe("read");
        const camera = result.camera;
        showCamera(camera);
        headingValue = normalizeHeading(camera.heading);
        headingDragBase = headingValue;
        root.querySelector("#heading").value = 0;
        showHeading();
        root.querySelector("#height").value = camera.z.toFixed(1);
        root.querySelector("#tilt").value = camera.tilt.toFixed(1);
        root.querySelector("#tilt-preset").value = ["60", "90", "110"].find(
          (value) => Number(value) === Math.round(camera.tilt)
        ) || "";
        if (Number.isFinite(camera.fov)) {
          root.querySelector("#fov").value = camera.fov.toFixed(4);
          root.querySelector("#fov-preset").value = lensValues.find(
            (value) => Math.abs(Number(value) - camera.fov) < 0.001
          ) || "";
        }
        status("已获取当前视图机位并回填参数。");
      }
      catch (error) { status(error.message); }
    };
    root.querySelector("#pick").onclick = async () => {
      if (locating) { status("请先清除圆圈并返回原视角，再点选新的中心。"); return; }
      status("请在场景中点击要作为旋转中心的位置。");
      try { fillOrbit(await askProbe("pick")); status("已取得点击位置，并按表面高度上移 1 米。"); }
      catch (error) { status(error.message); }
    };
    root.querySelector("#locate").onclick = async () => {
      try {
        const result = await askProbe(locating ? "exitLocation" : "locate");
        locating = result.locating;
        root.querySelector("#locate").textContent = locating ? "清除圆圈并返回原视角" : "查看机位位置";
        if (!locating) showCamera(result.camera);
        status(result.message);
      } catch (error) { status(error.message); }
    };
    root.querySelector("#apply").onclick = applyOrbit;
    root.querySelector("#heading").oninput = (event) => {
      headingValue = normalizeHeading(headingDragBase + Number(event.target.value));
      showHeading();
      clearTimeout(orbitTimer);
      orbitTimer = setTimeout(applyOrbit, 140);
    };
    root.querySelector("#heading").onchange = (event) => {
      headingDragBase = headingValue;
      event.target.value = 0;
    };
    root.querySelector("#tilt-preset").onchange = (event) => {
      if (event.target.value) {
        root.querySelector("#tilt").value = event.target.value;
        if (selectedTarget) applyOrbit();
      }
    };
    root.querySelector("#tilt").oninput = (event) => {
      root.querySelector("#tilt-preset").value = ["60", "90", "110"].includes(event.target.value)
        ? event.target.value : "";
    };
    root.querySelector("#fov-preset").onchange = (event) => {
      if (!event.target.value) return;
      root.querySelector("#fov").value = event.target.value;
      applyLens();
    };
    root.querySelector("#fov").onchange = (event) => {
      const fov = Number(event.target.value);
      root.querySelector("#fov-preset").value = lensValues.find(
        (value) => Math.abs(Number(value) - fov) < 0.001
      ) || "";
      applyLens();
    };
    for (const button of root.querySelectorAll("[data-direction]")) {
      button.onclick = async () => {
        if (!selectedTarget) { status("请先点选中心。"); return; }
        try {
          const result = await askProbe("step", {
            ...options(), direction: button.dataset.direction,
            distance: Number(root.querySelector("#distance").value)
          });
          showTarget(result.target);
          showCamera(result.camera);
          status(`中心已向${button.textContent}移动。`);
        } catch (error) { status(error.message); }
      };
    }
    root.querySelector("#share").onclick = async () => {
      try {
        const result = await askProbe("read");
        showCamera(result.camera);
        const url = new URL(location.href);
        const params = new URLSearchParams(url.hash.split("?")[1] || "");
        const encoded = await cityCameraCodec.encrypt(result.camera, result.target);
        params.delete("astarCamera");
        params.set("astarCamera2", encoded);
        url.hash = `#city-camera?${params}`;
        await navigator.clipboard.writeText(url.href);
        status("分享链接已复制；接收者需安装此扩展。");
      } catch (error) { status(`复制失败：${error.message}`); }
    };
    root.querySelector("#import").onclick = async () => {
      try {
        const shared = await decodeCamera(root.querySelector("#import-text").value);
        const result = await askProbe("goto", shared);
        showCamera(result.camera);
        if (result.target) fillOrbit(result);
        else showTarget(null);
        status("已导入并到达分享机位。");
      } catch (error) { status(`导入失败：${error.message}`); }
    };
    root.querySelector("#force-model").onchange = async (event) => {
      const enabled = event.target.checked;
      root.querySelector("#force-status").textContent = enabled ? "正在尝试恢复模型显示…" : "正在关闭显示修复…";
      try {
        await askProbe("force", enabled);
        await chrome.storage.local.set({ [FORCE_KEY]: enabled });
      } catch (error) {
        event.target.checked = !enabled;
        root.querySelector("#force-status").textContent = error.message;
      }
    };
    chrome.storage.local.get(FORCE_KEY).then((saved) => {
      if (saved[FORCE_KEY] === true) {
        root.querySelector("#force-model").checked = true;
        askProbe("force", true).catch((error) => {
          root.querySelector("#force-status").textContent = error.message;
        });
      }
    });
    root.querySelector("#save-button").onclick = async () => {
      if (!currentCamera) { status("请先拾取当前机位。"); return; }
      const input = root.querySelector("#name");
      const name = input.value.trim();
      if (!name) { status("请输入机位名称。"); return; }
      const presets = await loadPresets();
      presets.push({
        id: crypto.randomUUID(), name,
        camera: cityCameraCodec.minimalCamera(currentCamera),
        target: cityCameraCodec.minimalTarget(selectedTarget)
      });
      await chrome.storage.local.set({ [STORAGE_KEY]: presets });
      input.value = "";
      status(`已保存：${name}`);
      await renderPresets();
    };
    const setCelestialPanel = open => {
      const panel = root.querySelector("#celestial-dock");
      panel.hidden = !open;
      root.querySelector("#open-celestial").setAttribute("aria-pressed", String(open));
      if (open) scheduleCelestialUpdate();
    };
    root.querySelector("#open-celestial").onclick = () => setCelestialPanel(root.querySelector("#celestial-dock").hidden);
    root.querySelector("#close-celestial").onclick = () => setCelestialPanel(false);
    initializeShanghaiTime();
    root.querySelector("#celestial-date").onchange = scheduleCelestialUpdate;
    root.querySelector("#celestial-time").oninput = (event) => {
      const value = `${timeText(event.target.value)}:00`;
      root.querySelector("#celestial-exact-time").value = value;
      root.querySelector("#celestial-time-label").textContent = value;
      scheduleCelestialUpdate();
    };
    root.querySelector("#celestial-exact-time").onchange = (event) => {
      const parts = event.target.value.split(":").map(Number);
      if (parts.length >= 2 && parts.every(Number.isFinite)) {
        root.querySelector("#celestial-time").value = String(parts[0] * 60 + parts[1]);
        root.querySelector("#celestial-time-label").textContent = event.target.value;
        scheduleCelestialUpdate();
      }
    };
    root.querySelector("#celestial-visible").onchange = async (event) => {
      if (event.target.checked) await updateCelestial();
      else {
        clearTimeout(celestialTimer);
        if (celestialPlayTimer) clearInterval(celestialPlayTimer);
        celestialPlayTimer = null;
        root.querySelector("#celestial-play").textContent = "播放一天";
        await askProbe("clearCelestial").catch(() => {});
      }
    };
    root.querySelector("#celestial-play").onclick = () => {
      const button = root.querySelector("#celestial-play");
      if (celestialPlayTimer) {
        clearInterval(celestialPlayTimer);
        celestialPlayTimer = null;
        button.textContent = "播放一天";
        return;
      }
      if (!selectedTarget) { status("请先点选中心位置。"); return; }
      root.querySelector("#celestial-visible").checked = true;
      button.textContent = "暂停";
      celestialPlayTimer = setInterval(() => {
        const slider = root.querySelector("#celestial-time");
        slider.value = String((Number(slider.value) + 5) % 1440);
        const value = `${timeText(slider.value)}:00`;
        root.querySelector("#celestial-exact-time").value = value;
        root.querySelector("#celestial-time-label").textContent = value;
        scheduleCelestialUpdate();
      }, 120);
      updateCelestial();
    };
    root.querySelector("#celestial-clear").onclick = async () => {
      clearTimeout(celestialTimer);
      root.querySelector("#celestial-visible").checked = false;
      if (celestialPlayTimer) clearInterval(celestialPlayTimer);
      celestialPlayTimer = null;
      root.querySelector("#celestial-play").textContent = "播放一天";
      await askProbe("clearCelestial").catch(() => {});
      status("已清除日月轨迹。");
    };

    setupImageSharing();
    setupExport();
    renderPresets();
    const hello = () => sceneWindow()?.postMessage({
      channel: CHANNEL, from: "panel", type: "hello", requestId: 0
    }, location.origin);
    hello();
    handshakeTimer = setInterval(hello, 500);
  };

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== sceneWindow() || event.origin !== location.origin ||
        message?.channel !== CHANNEL || message.from !== "probe") return;
    if (message.type === "ready") {
      clearInterval(handshakeTimer);
      handshakeTimer = null;
      status("场景已就绪，可以点选中心。");
      if (hasSharedCamera() && !sharedCameraOpened) {
        sharedCameraOpened = true;
        decodeCamera(location.href).then((shared) =>
        askProbe("goto", shared)
      ).then((result) => {
        showCamera(result.camera);
        if (result.target) fillOrbit(result);
        status("已打开分享机位。");
      }).catch((error) => {
        root.querySelector("#import-text").value = location.href;
        root.querySelector("#import-text").closest("details").open = true;
        status(error.message);
      });
      }
    }
    if (message.type === "armed") status("正在等待场景加载…");
    if (message.type === "locationView" && root) {
      locating = message.locating;
      root.querySelector("#locate").textContent = locating ? "清除圆圈并返回原视角" : "查看机位位置";
    }
    if (message.type === "forceStatus" && root) {
      root.querySelector("#force-status").textContent = message.message;
      root.querySelector("#force-model").checked = message.enabled;
    }
    if (message.type === "picking") return;
    if (message.requestId != null && pending.has(message.requestId)) {
      const entry = pending.get(message.requestId);
      clearTimeout(entry.timeout);
      pending.delete(message.requestId);
      if (message.type === "error") entry.reject(new Error(message.message));
      else entry.resolve(message);
    } else if (message.type === "error") status(message.message);
  });

  const start = () => {
    if (location.pathname.startsWith("/city-scene/")) {
      mount();
      return;
    }
    const tryMount = () => {
      if (!sceneWindow()) return;
      observer.disconnect();
      mount();
    };
    const observer = new MutationObserver(tryMount);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    tryMount();
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();

