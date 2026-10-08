(() => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const toBase64Url = (bytes) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const fromBase64Url = (value) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("分享链接格式不正确。");
    }
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  };
  const minimalCamera = (camera) => {
    if (![camera?.x, camera?.y, camera?.z, camera?.heading, camera?.tilt].every(Number.isFinite)) {
      throw new Error("机位参数不完整。");
    }
    return {
      x: camera.x, y: camera.y, z: camera.z,
      heading: camera.heading, tilt: camera.tilt,
      fov: Number.isFinite(camera.fov) ? camera.fov : undefined,
      spatialReference: camera.spatialReference?.wkid
        ? { wkid: camera.spatialReference.wkid } : undefined
    };
  };
  const minimalTarget = (target) => {
    if (target == null) return null;
    if (![target.longitude, target.latitude].every(Number.isFinite) ||
        Math.abs(target.longitude) > 180 || Math.abs(target.latitude) > 90) {
      throw new Error("中心位置不完整。");
    }
    return {
      longitude: target.longitude,
      latitude: target.latitude,
      z: Number.isFinite(target.z) ? target.z : 0
    };
  };
  const encrypt = async (camera, target = null) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const envelope = { v: 2, iv: toBase64Url(iv), key: toBase64Url(rawKey) };
    const key = await crypto.subtle.importKey(
      "raw", rawKey, "AES-GCM", false, ["encrypt"]
    );
    const data = encoder.encode(JSON.stringify({
      camera: minimalCamera(camera), target: minimalTarget(target)
    }));
    envelope.data = toBase64Url(new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, key, data
    )));
    return toBase64Url(encoder.encode(JSON.stringify(envelope)));
  };
  const decrypt = async (encoded) => {
    let envelope;
    try { envelope = JSON.parse(decoder.decode(fromBase64Url(encoded))); }
    catch { throw new Error("分享链接格式不正确。"); }
    if (envelope?.v !== 2 || !envelope.iv || !envelope.data || !envelope.key) {
      throw new Error("分享链接格式不正确。");
    }
    try {
      const key = await crypto.subtle.importKey(
        "raw", fromBase64Url(envelope.key), "AES-GCM", false, ["decrypt"]
      );
      const data = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64Url(envelope.iv) },
        key, fromBase64Url(envelope.data)
      );
      const payload = JSON.parse(decoder.decode(data));
      return payload.camera
        ? { camera: minimalCamera(payload.camera), target: minimalTarget(payload.target) }
        : { camera: minimalCamera(payload), target: null };
    } catch {
      throw new Error("分享链接已损坏。");
    }
  };
  globalThis.cityCameraCodec = { encrypt, decrypt, minimalCamera, minimalTarget };
})();
