(() => {
  const CHANNEL = "astar-camera-v1";
  const EARTH_RADIUS = 6371008.8;
  let view = null;
  let pickHandle = null;
  let target = null;
  let forceEnabled = false;
  let patchedMap = null;
  let originalAdd = null;
  let originalRemove = null;
  let zoomWatcher = null;
  let forceTimer = null;
  let locationCamera = null;
  let locationPoint = null;
  let locationCircle = null;
  let locationFrame = null;
  let celestialOverlay = null;
  let celestialFrame = null;
  let celestialPayload = null;
  let celestialLastDraw = 0;
  let celestialRenderer = null;
  let celestialProjection = null;
  const layerStates = new Map();

  const send = (type, data = {}) => {
    const recipient = window.parent !== window ? window.parent : window;
    recipient.postMessage({ channel: CHANNEL, from: "probe", type, ...data }, location.origin);
  };

  const isTargetView = (candidate) => {
    const container = candidate?.container;
    return container === "viewDiv" || container?.id === "viewDiv";
  };

  const capture = (candidate) => {
    if (!isTargetView(candidate) || candidate === view) return;
    clearLocationView();
    clearCelestialOverlay();
    if (patchedMap && patchedMap !== candidate.map) unpatchMap();
    view = candidate;
    patchMap(candidate.map);
    window.require?.(["geoscene/views/3d/externalRenderers"], renderer => { celestialRenderer = renderer; });
    send("ready");
    if (forceEnabled) applyForce();
  };

  const layerItems = (map) => map?.layers?.toArray?.() || map?.layers?.items || [];
  const isModelLayer = (layer) => {
    const url = String(layer?.url || "");
    return ["/shanghai_nhn/", "/kysq/", "/shanghai_nhw/", "/shanghai_bm/"]
      .some((part) => url.includes(`${part}SceneServer/layers/0`));
  };
  const modelLayers = (map) => layerItems(map)
    .filter(isModelLayer);

  const restoreLayerStates = () => {
    for (const [layer, state] of layerStates) {
      layer.visible = state.visible;
      layer.minScale = state.minScale;
      layer.maxScale = state.maxScale;
    }
    layerStates.clear();
  };

  const unpatchMap = () => {
    if (!patchedMap) return;
    restoreLayerStates();
    patchedMap.add = originalAdd;
    patchedMap.remove = originalRemove;
    patchedMap = null;
    originalAdd = null;
    originalRemove = null;
  };

  const patchMap = (map) => {
    if (!map || patchedMap === map) return;
    if (patchedMap) unpatchMap();
    patchedMap = map;
    originalAdd = map.add;
    originalRemove = map.remove;
    map.add = function (layer, ...args) {
      if (forceEnabled && isModelLayer(layer)) {
        for (const oldLayer of modelLayers(map)) {
          if (oldLayer !== layer && String(oldLayer.url || "") === String(layer.url || "")) {
            layerStates.delete(oldLayer);
            originalRemove.call(map, oldLayer);
          }
        }
      }
      const result = originalAdd.call(this, layer, ...args);
      if (forceEnabled && isModelLayer(layer)) applyForce();
      return result;
    };
    map.remove = function (layer, ...args) {
      if (forceEnabled && isModelLayer(layer) && layerItems(map).includes(layer)) {
        applyForce();
        return layer;
      }
      return originalRemove.call(this, layer, ...args);
    };
  };

  const applyForce = () => {
    if (!forceEnabled || !view?.map) return;
    const layers = modelLayers(view.map);
    for (const layer of layers) {
      if (!layerStates.has(layer)) layerStates.set(layer, {
        visible: layer.visible, minScale: layer.minScale, maxScale: layer.maxScale
      });
      layer.visible = true;
      layer.minScale = 0;
      layer.maxScale = 0;
    }
    if (layers.length) {
      send("forceStatus", {
        message: `已找到模型，正在尝试维持显示；当前高度 ${Number.isFinite(view.camera?.position?.z) ? view.camera.position.z.toFixed(1) : "—"} m。`,
        enabled: true
      });
    } else {
      send("forceStatus", { message: "模型尚未显示。请先在原页面打开模型显示选项。", enabled: true });
      zoomWatcher?.(15);
    }
  };

  const setForce = (enabled) => {
    forceEnabled = enabled;
    clearInterval(forceTimer);
    forceTimer = null;
    if (enabled) {
      if (view?.map) patchMap(view.map);
      applyForce();
      forceTimer = setInterval(applyForce, 1500);
    } else {
      restoreLayerStates();
      if (view && zoomWatcher) zoomWatcher(view.zoom);
      send("forceStatus", { message: "已关闭模型显示修复。", enabled: false });
    }
  };

  const readCamera = () => {
    if (!view?.camera || !isTargetView(view)) throw new Error("场景尚未就绪，请等待页面加载完成后刷新。");
    const camera = view.camera;
    const position = camera.position;
    if (!position) throw new Error("相机位置尚未就绪。");
    return {
      x: position.x,
      y: position.y,
      z: position.z,
      longitude: position.longitude,
      latitude: position.latitude,
      spatialReference: position.spatialReference?.toJSON?.() || view.spatialReference?.toJSON?.(),
      heading: camera.heading,
      tilt: camera.tilt,
      fov: camera.fov
    };
  };

  const clearLocationView = () => {
    if (locationFrame != null) window.cancelAnimationFrame(locationFrame);
    locationCircle?.remove();
    locationFrame = null;
    locationCircle = null;
    locationPoint = null;
    if (locationCamera) {
      locationCamera = null;
      send("locationView", { locating: false });
    }
  };

  const updateLocationCircle = () => {
    if (!locationCircle || !view) return;
    const container = typeof view.container === "string"
      ? document.getElementById(view.container) : view.container;
    const rect = container?.getBoundingClientRect?.();
    const point = view.toScreen?.(locationPoint);
    if (rect && Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
      const diameter = Math.min(rect.width, rect.height) / 3;
      Object.assign(locationCircle.style, {
        display: "block",
        width: `${diameter}px`, height: `${diameter}px`,
        left: `${rect.left + point.x - diameter / 2}px`,
        top: `${rect.top + point.y - diameter / 2}px`
      });
    } else {
      locationCircle.style.display = "none";
    }
    locationFrame = window.requestAnimationFrame(updateLocationCircle);
  };

  const radians = (degrees) => degrees * Math.PI / 180;
  const degrees = (radiansValue) => radiansValue * 180 / Math.PI;
  const normalizeHeading = (heading) => (heading % 360 + 360) % 360;
  const distanceMeters = (a, b) => {
    const dLat = radians(b.latitude - a.latitude);
    const dLon = radians(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const bearing = (a, b) => normalizeHeading(degrees(Math.atan2(
    Math.sin(radians(b.longitude - a.longitude)) * Math.cos(radians(b.latitude)),
    Math.cos(radians(a.latitude)) * Math.sin(radians(b.latitude)) -
      Math.sin(radians(a.latitude)) * Math.cos(radians(b.latitude)) *
      Math.cos(radians(b.longitude - a.longitude))
  )));
  const destination = (start, bearingDegrees, meters) => {
    const phi1 = radians(start.latitude);
    const lambda1 = radians(start.longitude);
    const theta = radians(bearingDegrees);
    const delta = meters / EARTH_RADIUS;
    const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) +
      Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
    const lambda2 = lambda1 + Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    );
    return { longitude: (degrees(lambda2) + 540) % 360 - 180, latitude: degrees(phi2) };
  };
  const mapPosition = (longitude, latitude, z) => {
    const wkid = view.spatialReference?.wkid;
    if (wkid === 4326) return { x: longitude, y: latitude, z, spatialReference: { wkid } };
    if (wkid === 3857 || wkid === 102100) {
      const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
      return {
        x: 6378137 * radians(longitude),
        y: 6378137 * Math.log(Math.tan(Math.PI / 4 + radians(lat) / 2)),
        z,
        spatialReference: { wkid: 3857 }
      };
    }
    throw new Error("暂不支持当前场景的位置设置。");
  };
  const pointCoordinates = (point) => {
    if (Number.isFinite(point?.longitude) && Number.isFinite(point?.latitude)) {
      return { longitude: point.longitude, latitude: point.latitude, z: point.z || 0 };
    }
    const wkid = point?.spatialReference?.wkid;
    if (wkid === 4326) return { longitude: point.x, latitude: point.y, z: point.z || 0 };
    if (wkid === 3857 || wkid === 102100) {
      return {
        longitude: degrees(point.x / 6378137),
        latitude: degrees(2 * Math.atan(Math.exp(point.y / 6378137)) - Math.PI / 2),
        z: point.z || 0
      };
    }
    throw new Error("无法读取点击位置的经纬度。");
  };
  const setCamera = (position, heading, tilt, fov) => {
    if (!view?.camera) throw new Error("场景尚未就绪。");
    if (locationCamera) clearLocationView();
    const camera = view.camera.clone();
    const cameraPosition = camera.position.clone();
    const currentWkid = cameraPosition.spatialReference?.wkid;
    const savedWkid = position.spatialReference?.wkid;
    if (savedWkid && currentWkid && savedWkid !== currentWkid &&
        !([3857, 102100].includes(savedWkid) && [3857, 102100].includes(currentWkid))) {
      throw new Error("机位位置与当前场景不一致。");
    }
    cameraPosition.x = position.x;
    cameraPosition.y = position.y;
    cameraPosition.z = position.z;
    camera.position = cameraPosition;
    camera.heading = heading;
    camera.tilt = tilt;
    if (Number.isFinite(fov)) camera.fov = fov;
    view.camera = camera;
    const actual = readCamera();
    if (Math.abs(actual.x - position.x) > 0.01 ||
        Math.abs(actual.y - position.y) > 0.01 ||
        Math.abs(actual.z - position.z) > 0.01 ||
        (Number.isFinite(fov) && Math.abs(actual.fov - fov) > 0.01)) {
      throw new Error("相机未到达指定机位，请检查页面是否正在切换视图。");
    }
    return actual;
  };

  const locateCamera = () => {
    if (locationCamera) throw new Error("已在位置查看模式，请先清除圆圈并返回原视角。");
    const original = readCamera();
    const point = target
      ? mapPosition(target.longitude, target.latitude, target.z)
      : original;
    const camera = setCamera({ ...point, z: 650 }, 0, 0);
    locationCamera = original;
    locationPoint = view.camera.position.clone();
    locationPoint.z = target?.z || 0;
    locationCircle = document.createElement("div");
    Object.assign(locationCircle.style, {
      position: "fixed", boxSizing: "border-box", borderRadius: "50%",
      border: "2px solid rgba(8, 142, 133, .9)",
      background: "rgba(12, 157, 147, .18)",
      boxShadow: "0 0 0 1px rgba(255, 255, 255, .7) inset",
      pointerEvents: "none", zIndex: "2147483645"
    });
    document.body.append(locationCircle);
    updateLocationCircle();
    send("locationView", { locating: true });
    return {
      camera, locating: true,
      message: target
        ? "已从上方显示旋转中心；绿色圆圈标出原来的中心位置。"
        : "旧机位未保存旋转中心，已从上方显示相机所在位置。"
    };
  };

  const exitLocationView = () => {
    if (!locationCamera) throw new Error("当前未在位置查看模式。");
    const original = locationCamera;
    clearLocationView();
    return {
      camera: setCamera(original, original.heading, original.tilt),
      locating: false, message: "已清除圆圈并返回原视角。"
    };
  };

  const orbit = async (options) => {
    if (!view?.camera || !target) throw new Error("请先在场景中点选中心位置。");
    const { heading, height, tilt, fov } = options;
    if (![heading, height, tilt].every(Number.isFinite) ||
        height <= 0 || tilt < 0 || tilt > 150 ||
        (fov != null && (!Number.isFinite(fov) || fov < 1 || fov > 170))) {
      throw new Error("机位参数无效；机位角度须为 0° 至 150°，镜头视角须为 1° 至 170°。");
    }
    const location = destination(target, normalizeHeading(heading + 180), 0.2);
    const camera = setCamera(
      mapPosition(location.longitude, location.latitude, height),
      normalizeHeading(heading), tilt, fov
    );
    return { camera, target, heading: normalizeHeading(heading), height, tilt, fov: camera.fov };
  };

  let annotationsHidden = false;
  let annotationTimer = null;
  const annotationStates = new Map();
  const rememberAnnotation = (object, property, value = false) => {
    let properties = annotationStates.get(object);
    if (!properties) annotationStates.set(object, properties = new Map());
    if (!properties.has(property)) properties.set(property, object[property]);
    object[property] = value;
  };
  const hideAnnotations = () => {
    if (!annotationsHidden || !view?.map) return;
    const seen = new Set();
    const walk = collection => {
      for (const layer of collection?.toArray?.() || collection?.items || []) {
        if (seen.has(layer)) continue;
        seen.add(layer);
        const name = `${layer.title || ""} ${layer.id || ""}`;
        if (/名称标记|注记|标注|地名|label|annotation/i.test(name)) rememberAnnotation(layer, "visible");
        if ("labelsVisible" in layer) rememberAnnotation(layer, "labelsVisible");
        walk(layer.layers); walk(layer.sublayers);
      }
    };
    walk(view.map.allLayers || view.map.layers);
    walk(view.map.basemap?.baseLayers); walk(view.map.basemap?.referenceLayers);
    if (locationCircle?.style) rememberAnnotation(locationCircle.style, "visibility", "hidden");
  };
  const setAnnotations = hidden => {
    if (!view?.map) throw new Error("场景尚未就绪。");
    clearInterval(annotationTimer);
    annotationsHidden = hidden;
    if (hidden) {
      hideAnnotations(); annotationTimer = setInterval(hideAnnotations, 250);
    } else {
      for (const [object, properties] of annotationStates)
        for (const [property, value] of properties) object[property] = value;
      annotationStates.clear();
    }
    return { hidden, count: annotationStates.size };
  };
  const screenshot = async options => {
    if (!view?.takeScreenshot) throw new Error("场景尚未就绪。");
    const width = Number(options?.width), height = Number(options?.height);
    if (![width, height].every(Number.isInteger) || width < 320 || height < 180 || width > 3840 || height > 2160)
      throw new Error("导出分辨率无效。");
    hideAnnotations();
    const deadline = Date.now() + 30000;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    while (view.updating) {
      if (Date.now() > deadline) throw new Error("场景加载超时，请等待模型加载完成后再导出。");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const shot = await view.takeScreenshot({ width, height, format: "png" });
    return { dataUrl: shot.dataUrl };
  };

  let shareCaptureBusy = false;
  const shareScreenshot = async options => {
    if (!view?.takeScreenshot || locationCamera) throw new Error('请先返回机位视角，再生成分享图。');
    if (!['portrait','landscape'].includes(options?.orientation)) throw new Error('请选择横拍或竖拍。');
    const scene = view;
    const container = typeof scene.container === 'string' ? document.getElementById(scene.container) : scene.container;
    if (!container) throw new Error('场景容器尚未就绪。');
    const portrait = options.orientation === 'portrait';
    const renderWidth = portrait ? 600 : 900, renderHeight = portrait ? 900 : 600;
    const width = renderWidth*2, height = renderHeight*2;
    const style = container.getAttribute('style'), padding = scene.padding;
    const camera = scene.camera.clone(), savedCamera = readCamera();
    const savedTarget = target ? {...target} : null;
    const stopInput = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const events = ['pointerdown','pointermove','wheel','keydown','touchstart'];
    shareCaptureBusy = true;
    try {
      for (const name of events) container.addEventListener(name,stopInput,{capture:true,passive:false});
      // Render a real fixed-ratio scene instead of stretching a browser screenshot.
      for (const [key,value] of Object.entries({position:'fixed',left:'0',top:'0',right:'auto',bottom:'auto',
        width:renderWidth+'px',height:renderHeight+'px','min-width':'0','min-height':'0',
        'max-width':'none','max-height':'none',transform:'none','box-sizing':'border-box',border:'0',padding:'0'}))
        container.style.setProperty(key,value,'important');
      scene.padding = {left:0,right:0,top:0,bottom:0};
      const deadline = Date.now()+30000;
      do {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (Date.now()>deadline) throw new Error('场景画幅调整超时，请等待加载完成后重试。');
      } while (Math.abs(scene.width-renderWidth)>1 || Math.abs(scene.height-renderHeight)>1);
      scene.camera = camera.clone();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      while (scene.updating) {
        if (Date.now()>deadline) throw new Error('场景加载超时，请等待模型加载完成后重试。');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      if (view !== scene) throw new Error('场景已切换，请重新生成分享图。');
      const actual = readCamera();
      if (['x','y','z','heading','tilt','fov'].some(key=>Math.abs(actual[key]-savedCamera[key])>0.001))
        throw new Error('生成期间机位发生变化，请重新生成。');
      hideAnnotations();
      const shot = await scene.takeScreenshot({width,height,format:'png',area:{x:0,y:0,width:renderWidth,height:renderHeight}});
      let skySvg = null;
      if (celestialOverlay && celestialPayload && target) {
        if (celestialFrame != null) cancelAnimationFrame(celestialFrame);
        celestialLastDraw = 0;
        drawCelestialOverlay(performance.now()+100);
        const overlay = celestialOverlay.cloneNode(true);
        overlay.removeAttribute('style');
        overlay.setAttribute('width',String(width)); overlay.setAttribute('height',String(height));
        skySvg = new XMLSerializer().serializeToString(overlay);
      }
      return {dataUrl:shot.dataUrl,camera:savedCamera,target:savedTarget,skySvg};
    } finally {
      if (style == null) container.removeAttribute('style'); else container.setAttribute('style',style);
      scene.padding = padding;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      scene.camera = camera;
      for (const name of events) container.removeEventListener(name,stopInput,true);
      shareCaptureBusy = false;
    }
  };
  const clearCelestialOverlay = () => {
    if (celestialFrame != null) window.cancelAnimationFrame(celestialFrame);
    celestialOverlay?.remove();
    celestialOverlay = null;
    celestialFrame = null;
    celestialPayload = null;
    celestialLastDraw = 0;
  };

  const svgElement = (name, attributes = {}) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  };

  const scenePoint = (longitude, latitude, z) => {
    const values = mapPosition(longitude, latitude, z);
    const point = view.camera.position.clone();
    point.x = values.x;
    point.y = values.y;
    point.z = values.z;
    return point;
  };

  const projectSkyPosition = (position, rect) => {
    if (!position || position.altitude < 0 || !view?.camera || !rect) return null;
    const azimuth = radians(position.azimuth);
    const altitude = radians(position.altitude);
    const heading = radians(view.camera.heading || 0);
    // This site's SceneView uses >90 for looking upward, as in the AStar panel.
    const cameraAltitude = radians((Number.isFinite(view.camera.tilt) ? view.camera.tilt : 90) - 90);
    const direction = [
      Math.sin(azimuth) * Math.cos(altitude),
      Math.cos(azimuth) * Math.cos(altitude),
      Math.sin(altitude)
    ];
    if (celestialProjection) {
      const multiply = (matrix, vector) => [0, 1, 2, 3].map(row =>
        [0, 1, 2, 3].reduce((sum, column) => sum + matrix[column * 4 + row] * vector[column], 0));
      const world = multiply(celestialProjection.local, [...direction, 0]);
      const eye = multiply(celestialProjection.view, world);
      const clip = multiply(celestialProjection.projection, eye);
      if (eye[2] >= -0.01 || clip[3] <= 0) return null;
      return {
        x: (clip[0] / clip[3] + 1) * rect.width / 2,
        y: (1 - clip[1] / clip[3]) * rect.height / 2
      };
    }
    const forward = [
      Math.sin(heading) * Math.cos(cameraAltitude),
      Math.cos(heading) * Math.cos(cameraAltitude),
      Math.sin(cameraAltitude)
    ];
    const right = [Math.cos(heading), -Math.sin(heading), 0];
    const up = [
      -Math.sin(heading) * Math.sin(cameraAltitude),
      -Math.cos(heading) * Math.sin(cameraAltitude),
      Math.cos(cameraAltitude)
    ];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const depth = dot(direction, forward);
    if (depth <= 0.01) return null;
    const fieldOfView = Math.max(1, Math.min(170, Number(view.camera.fov) || 55));
    const focal = Math.hypot(rect.width, rect.height) /
      (2 * Math.tan(radians(fieldOfView) / 2));
    const point = {
      x: rect.width / 2 + dot(direction, right) / depth * focal,
      y: rect.height / 2 - dot(direction, up) / depth * focal
    };
    if (point.x < -rect.width * 2 || point.x > rect.width * 3 ||
        point.y < -rect.height * 2 || point.y > rect.height * 3) return null;
    return point;
  };

  const pathForTrajectory = (samples, rect) => {
    const parts = [];
    let drawing = false;
    for (const sample of samples || []) {
      const point = sample.visible ? projectSkyPosition(sample, rect) : null;
      if (!point) { drawing = false; continue; }
      parts.push(`${drawing ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`);
      drawing = true;
    }
    return parts.join(" ");
  };

  const drawCelestialOverlay = (timestamp = 0) => {
    if (!celestialOverlay || !celestialPayload || !view || !target) return;
    celestialFrame = window.requestAnimationFrame(drawCelestialOverlay);
    if (timestamp - celestialLastDraw < 80) return;
    celestialLastDraw = timestamp;
    const container = typeof view.container === "string"
      ? document.getElementById(view.container) : view.container;
    const rect = container?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) return;
    Object.assign(celestialOverlay.style, {
      left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`, display: "block"
    });
    celestialOverlay.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    celestialOverlay.replaceChildren();
    celestialProjection = null;
    if (celestialRenderer) {
      try {
        const camera = celestialRenderer.getRenderCamera(view);
        const point = view.camera.position;
        const local = new Float64Array(16);
        celestialRenderer.renderCoordinateTransformAt(view, [point.x, point.y, point.z], point.spatialReference, local);
        if (camera?.viewMatrix && camera?.projectionMatrix) {
          celestialProjection = { local, view: camera.viewMatrix, projection: camera.projectionMatrix };
        }
      } catch (_) { /* Use the AStar camera projection until the renderer is ready. */ }
    }
    let center = null;
    try { center = view.toScreen?.(scenePoint(target.longitude, target.latitude, target.z)); }
    catch (_) { /* A center outside the current view must not hide the sky markers. */ }
    const bodies = [
      { key: "sun", label: "太阳", color: "#f0b84f", dash: "9 7" },
      { key: "moon", label: "月亮", color: "#a9c9ff", dash: "5 7" }
    ];
    for (const body of bodies) {
      const path = pathForTrajectory(celestialPayload.trajectories?.[body.key], rect);
      if (path) celestialOverlay.append(svgElement("path", {
        d: path, fill: "none", stroke: body.color, "stroke-width": 2,
        "stroke-dasharray": body.dash, opacity: 0.9
      }));
      const current = projectSkyPosition(celestialPayload[body.key], rect);
      if (!current) continue;
      if (Number.isFinite(center?.x) && Number.isFinite(center?.y)) {
        celestialOverlay.append(svgElement("line", {
          x1: center.x, y1: center.y, x2: current.x, y2: current.y,
          stroke: body.color, "stroke-width": 1.5, opacity: 0.72
        }));
      }
      celestialOverlay.append(svgElement("circle", {
        cx: current.x, cy: current.y, r: body.key === "sun" ? 9 : 8,
        fill: body.color, stroke: "#ffffff", "stroke-width": 1.5
      }));
      const label = svgElement("text", {
        x: current.x + 13, y: current.y - 10, fill: "#ffffff",
        stroke: "#17313d", "stroke-width": 3, "paint-order": "stroke",
        "font-size": 12, "font-family": "Arial, sans-serif"
      });
      label.textContent = `${body.label} ${Math.round(celestialPayload[body.key].azimuth)}°`;
      celestialOverlay.append(label);
    }
  };

  const setCelestialOverlay = (payload) => {
    if (!target) throw new Error("请先点选中心位置，再显示日月轨迹。");
    if (![payload?.sun?.azimuth, payload?.sun?.altitude, payload?.moon?.azimuth, payload?.moon?.altitude].every(Number.isFinite)) throw new Error("日月数据不完整。");
    clearCelestialOverlay();
    celestialPayload = payload;
    celestialOverlay = svgElement("svg", { "aria-label": "日月方向与轨迹" });
    Object.assign(celestialOverlay.style, {
      position: "fixed", pointerEvents: "none", overflow: "hidden",
      zIndex: "2147483644"
    });
    document.body.append(celestialOverlay);
    drawCelestialOverlay();
    return { visible: true };
  };


  window.addEventListener("message", async (event) => {
    const message = event.data;
    const sender = window.parent !== window ? window.parent : window;
    if (event.source !== sender || event.origin !== location.origin ||
        message?.channel !== CHANNEL || message.from !== "panel") return;
    const requestId = message.requestId;
    try {
      if (shareCaptureBusy && message.type !== "hello") throw new Error("正在生成分享图，请稍候。");
      if (message.type === "hello") {
        send(view ? "ready" : "armed");
      } else if (message.type === "celestial") {
        send("result", { requestId, ...setCelestialOverlay(message.celestial) });
      } else if (message.type === "clearCelestial") {
        clearCelestialOverlay();
        send("result", { requestId, visible: false });
      } else if (message.type === "shareScreenshot") {
        send("result", { requestId, ...await shareScreenshot(message.options) });
      } else if (message.type === "annotations") {
        send("result", { requestId, ...setAnnotations(message.enabled === true) });
      } else if (message.type === "screenshot") {
        send("result", { requestId, ...await screenshot(message.options) });
      } else if (message.type === "read") {
        send("result", { requestId, camera: locationCamera || readCamera(), target });
      } else if (message.type === "locate") {
        send("result", { requestId, ...locateCamera() });
      } else if (message.type === "exitLocation") {
        send("result", { requestId, ...exitLocationView() });
      } else if (message.type === "force") {
        setForce(message.enabled === true);
        send("result", { requestId, enabled: forceEnabled });
      } else if (message.type === "lens") {
        const fov = Number(message.fov);
        if (!Number.isFinite(fov) || fov < 1 || fov > 170) {
          throw new Error("镜头视角须在 1° 至 170° 之间。");
        }
        const current = readCamera();
        const camera = setCamera(current, current.heading, current.tilt, fov);
        send("result", { requestId, camera, target, fov: camera.fov });
      } else if (message.type === "pick") {
        if (!view?.camera) throw new Error("场景尚未就绪。");
        pickHandle?.remove();
        pickHandle = view.on("click", (clickEvent) => {
          pickHandle?.remove();
          pickHandle = null;
          try {
            const point = clickEvent.mapPoint || view.toMap({ x: clickEvent.x, y: clickEvent.y });
            target = pointCoordinates(point);
            const camera = readCamera();
            const radius = distanceMeters(camera, target);
            send("result", {
              requestId, camera, target,
              heading: radius > 1 ? bearing(camera, target) : camera.heading,
              height: target.z + 1,
              tilt: camera.tilt,
              fov: camera.fov
            });
          } catch (error) {
            send("error", { requestId, message: String(error?.message || error) });
          }
        });
        send("picking", { requestId });
      } else if (message.type === "orbit") {
        send("result", { requestId, ...await orbit(message.options) });
      } else if (message.type === "step") {
        if (!target) throw new Error("请先在场景中点选中心位置。");
        const { direction, distance, heading, height, tilt } = message.options || {};
        if (!Number.isFinite(distance) || distance <= 0) throw new Error("请输入大于零的步进距离。");
        const offset = { forward: 0, backward: 180, left: -90, right: 90 }[direction];
        if (offset == null) throw new Error("步进方向无效。");
        const previousTarget = target;
        target = { ...target, ...destination(target, heading + offset, distance) };
        try {
          send("result", { requestId, ...await orbit({ heading, height, tilt }) });
        } catch (error) {
          target = previousTarget;
          throw error;
        }
      } else if (message.type === "goto") {
        const c = message.camera;
        if (!view || !isTargetView(view)) throw new Error("场景尚未就绪。");
        if (![c?.x, c?.y, c?.z, c?.heading, c?.tilt].every(Number.isFinite)) {
          throw new Error("机位参数不完整。");
        }
        const savedTarget = message.target;
        if (savedTarget != null &&
            (![savedTarget.longitude, savedTarget.latitude].every(Number.isFinite) ||
              Math.abs(savedTarget.longitude) > 180 || Math.abs(savedTarget.latitude) > 90)) {
          throw new Error("中心位置不完整。");
        }
        const camera = setCamera(c, c.heading, c.tilt, c.fov);
        clearCelestialOverlay();
        target = savedTarget == null ? null : {
          longitude: savedTarget.longitude,
          latitude: savedTarget.latitude,
          z: Number.isFinite(savedTarget.z) ? savedTarget.z : 0
        };
        send("result", {
          requestId, camera, target,
          heading: camera.heading,
          height: camera.z, tilt: camera.tilt, fov: camera.fov
        });
      }
    } catch (error) {
      send("error", { requestId, message: String(error?.message || error) });
    }
  });

  const hookSceneView = (attempt = 0) => {
    if (typeof window.require !== "function") {
      if (attempt >= 300) {
        send("error", { message: "无法接入 SceneView：页面模块加载超时。" });
        return;
      }
      setTimeout(() => hookSceneView(attempt + 1), 50);
      return;
    }
    window.require(["geoscene/views/SceneView"], (SceneView) => {
    if (typeof SceneView?.prototype?.on !== "function") {
      send("error", { message: "无法接入 SceneView：视图接口已变化。" });
      return;
    }
    if (SceneView.prototype.__cityCameraPatched) {
      send("armed");
      return;
    }
    Object.defineProperty(SceneView.prototype, "__cityCameraPatched", { value: true });
    const originalOn = SceneView.prototype.on;
    const originalWatch = SceneView.prototype.watch;
    SceneView.prototype.on = function (...args) {
      capture(this);
      return originalOn.apply(this, args);
    };
    if (typeof originalWatch === "function") {
      SceneView.prototype.watch = function (path, callback, ...args) {
        capture(this);
        if (isTargetView(this) && path === "zoom" && typeof callback === "function") {
          const wrapped = (zoom, ...rest) => callback(
            forceEnabled ? Math.max(15, Number.isFinite(zoom) ? zoom : 0) : zoom,
            ...rest
          );
          zoomWatcher = wrapped;
          return originalWatch.call(this, path, wrapped, ...args);
        }
        return originalWatch.call(this, path, callback, ...args);
      };
    }
    send("armed");
    }, (error) => {
    send("error", { message: `无法接入 SceneView：${String(error?.message || error)}` });
    });
  };
  hookSceneView();
})();
