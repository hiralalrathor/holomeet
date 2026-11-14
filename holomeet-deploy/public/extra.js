// HoloMeet add-ons: Socket.IO rooms, WebRTC mesh voice + spatial audio, screen share, head tracking, voice mask, WebXR
(() => {
  let ice = [{ urls: 'stun:stun.l.google.com:19302' }], socket = null, actx = null, micStream = null, outDst = null, dry = null, wet = null,
    maskOn = false, screenTrack = null, hy = 0, hp = 0, headTimer = null, headStream = null;
  const pcs = {}, pans = {}, origMat = screen.material, ctx = () => actx || (actx = new AudioContext());
  const tools = document.getElementById('tools');
  const add = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => fn(b); tools.append(b); return b; };

  // ---- tracks ----
  const setTrack = (k, t) => Object.values(pcs).forEach(pc => pc[k] && pc[k].replaceTrack(t).catch(() => {}));
  function bind(pc) {
    pc.getTransceivers().forEach(t => { t.direction = 'sendrecv'; if (t.receiver.track.kind === 'audio') pc.a = t.sender; else pc.v = t.sender; });
    if (micOn && outDst && pc.a) pc.a.replaceTrack(outDst.stream.getAudioTracks()[0]);
    if (screenTrack && pc.v) pc.v.replaceTrack(screenTrack);
  }
  // ---- mic with optional voice mask (ring modulator + low-pass) ----
  const applyMask = () => { if (dry) { dry.gain.value = maskOn ? 0 : 1; wet.gain.value = maskOn ? 1 : 0; } };
  toggleMic = async () => {
    if (micOn) { micOn = false; analyser = null; micStream.getTracks().forEach(t => t.stop()); setTrack('a', null); return; }
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { alert('Microphone unavailable.'); return; }
    const c = ctx(); await c.resume(); const src = c.createMediaStreamSource(micStream);
    analyser = c.createAnalyser(); analyser.fftSize = 256; src.connect(analyser);
    outDst = c.createMediaStreamDestination(); dry = c.createGain(); wet = c.createGain();
    const mod = c.createGain(); mod.gain.value = 0; const osc = c.createOscillator(); osc.frequency.value = 55; osc.connect(mod.gain); osc.start();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2800;
    src.connect(dry).connect(outDst); src.connect(mod).connect(lp).connect(wet).connect(outDst); applyMask();
    micOn = true; setTrack('a', outDst.stream.getAudioTracks()[0]);
  };
  add('🎭 Voice mask', b => { maskOn = !maskOn; b.classList.toggle('on', maskOn); applyMask(); });

  // ---- screen share ----
  const showScreen = v => { screen.material = new THREE.MeshBasicMaterial({ map: new THREE.VideoTexture(v) }); };
  function stopShare() { if (screenTrack) screenTrack.stop(); screenTrack = null; setTrack('v', null); screen.material = origMat; }
  add('🖥 Share screen', async () => {
    if (screenTrack) return stopShare();
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true }); screenTrack = s.getVideoTracks()[0];
      screenTrack.onended = stopShare; setTrack('v', screenTrack);
      const v = document.createElement('video'); v.muted = true; v.srcObject = s; v.play(); showScreen(v);
    } catch (e) {}
  });

  // ---- WebRTC mesh ----
  function mkpc(pid) {
    if (pcs[pid]) pcs[pid].close();
    const pc = new RTCPeerConnection({ iceServers: ice }); pcs[pid] = pc; pc.q = [];
    pc.onicecandidate = e => e.candidate && socket.emit('sig', { to: pid, data: { c: e.candidate } });
    pc.ontrack = e => {
      const s = new MediaStream([e.track]);
      if (e.track.kind === 'audio') { // spatialise through PannerNode
        const a = new Audio(); a.srcObject = s; a.muted = true; a.play().catch(() => {});
        const c = ctx(), p = c.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 1.5; p.rolloffFactor = 1.2;
        c.createMediaStreamSource(s).connect(p).connect(c.destination); pans[pid] = p;
      } else {
        const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = s; v.play().catch(() => {});
        e.track.onunmute = () => showScreen(v); e.track.onmute = () => { screen.material = origMat; };
      }
    };
    return pc;
  }
  async function call(pid) {
    const pc = mkpc(pid); pc.addTransceiver('audio'); pc.addTransceiver('video'); bind(pc);
    await pc.setLocalDescription(await pc.createOffer()); socket.emit('sig', { to: pid, data: { sdp: pc.localDescription } });
  }
  async function onSig({ from, data }) {
    let pc = pcs[from];
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        pc = mkpc(from); await pc.setRemoteDescription(data.sdp); bind(pc);
        await pc.setLocalDescription(await pc.createAnswer()); socket.emit('sig', { to: from, data: { sdp: pc.localDescription } });
      } else if (pc) await pc.setRemoteDescription(data.sdp);
      if (pc) { for (const c of pc.q.splice(0)) await pc.addIceCandidate(c).catch(() => {}); }
    } else if (data.c && pc) { if (pc.remoteDescription) pc.addIceCandidate(data.c).catch(() => {}); else pc.q.push(data.c); }
  }
  const _on = onMsg;
  onMsg = m => {
    const had = peers[m.id]; _on(m); const p = peers[m.id];
    if (m.t === 'bye') { if (pcs[m.id]) pcs[m.id].close(); delete pcs[m.id]; delete pans[m.id]; }
    if (p && m.t === 'head') { p.hy = m.hy; p.hp = m.hp; }
    if (!had && p && socket && id < m.id) call(m.id); // lower id initiates
  };
  document.getElementById('enter').addEventListener('click', () => {
    if (typeof io === 'undefined') return addLog('system', 'No server found: same-browser tabs only. Run server.js for cross-device rooms.', '#ffb347');
    try { bc2 && bc2.close(); } catch (e) {}
    socket = io();
    socket.on('cfg', c => { ice = c; });
    socket.on('m', m => onMsg(m));
    socket.on('sig', onSig);
    socket.on('board', l => l.forEach(s => drawSeg(s.a, s.b, '#00e5ff')));
    socket.on('connect', () => socket.emit('join', { room: me.room, id }));
    bc2 = { postMessage: m => socket.emit('m', m) };
    ctx().resume(); addLog('system', 'Server connected: cross-device rooms and voice active.', '#7fa3b3');
  });

  // ---- head tracking (MediaPipe, 100% local; only yaw/pitch sent) ----
  add('🧠 Head track', async b => {
    if (headTimer) { clearInterval(headTimer); headTimer = null; headStream.getTracks().forEach(t => t.stop()); hy = hp = 0; b.classList.remove('on'); return; }
    try {
      const V = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
      const { FaceLandmarker, FilesetResolver } = await import(V + '/+esm');
      const lm = await FaceLandmarker.createFromOptions(await FilesetResolver.forVisionTasks(V + '/wasm'), {
        baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' },
        runningMode: 'VIDEO', outputFacialTransformationMatrixes: true });
      headStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = headStream; await v.play();
      b.classList.add('on');
      headTimer = setInterval(() => {
        const r = lm.detectForVideo(v, performance.now()), m = r.facialTransformationMatrixes[0];
        if (m) { hy = -Math.atan2(m.data[8], m.data[10]); hp = Math.asin(-m.data[9]); send({ t: 'head', hy, hp }); }
      }, 80);
    } catch (e) { alert('Head tracking unavailable: ' + e.message); }
  });

  // ---- WebXR ----
  const xr = (mode, label) => navigator.xr && navigator.xr.isSessionSupported(mode).then(ok => ok && add(label, async () => {
    const s = await navigator.xr.requestSession(mode, { optionalFeatures: ['local-floor'] });
    const bg = scene.background; if (mode === 'immersive-ar') { scene.background = null; R.setClearAlpha(0); }
    s.addEventListener('end', () => { scene.background = bg; });
    R.xr.setReferenceSpaceType('local-floor'); await R.xr.setSession(s);
  })).catch(() => {});
  xr('immersive-vr', '🥽 Enter VR'); xr('immersive-ar', '📱 Enter AR');

  // ---- per-tick: audio listener/panners + head rotation ----
  setInterval(() => {
    if (actx) {
      const L = actx.listener, d = cam.getWorldDirection(new THREE.Vector3());
      if (L.positionX) { L.positionX.value = cam.position.x; L.positionY.value = cam.position.y; L.positionZ.value = cam.position.z;
        L.forwardX.value = d.x; L.forwardY.value = d.y; L.forwardZ.value = d.z; L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; }
      for (const k in pans) { const p = peers[k]; if (p && pans[k].positionX) { pans[k].positionX.value = p.g.position.x; pans[k].positionY.value = 1.6; pans[k].positionZ.value = p.g.position.z; } }
    }
    for (const k in peers) { const p = peers[k], b = p.g.children[0]; if (b) { b.rotation.y += ((p.hy || 0) - b.rotation.y) * .4; b.rotation.x += ((p.hp || 0) - b.rotation.x) * .4; } }
  }, 50);
})();
