/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Target, Zap } from 'lucide-react';

interface Particle {
  id: number;
  x: number;
  y: number;
  text: string;
  alpha: number;
  color: string;
  vx: number;
  vy: number;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [metrics, setMetrics] = useState({ input: 0, output: 0 });
  const [isInteractionActive, setIsInteractionActive] = useState(false);
  
  // Physics & State refs to avoid closure staleness in the loop
  const stateRef = useRef({
    cx: 0,
    cy: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    isDragging: false,
    maxDist: 0,
    hue: 190, // Start with cyan hue
    lightness: 25,
    saturation: 0,
    targetLightness: 25,
    targetSaturation: 0,
    baseR: 45,
    k: 0.04, // Lowered per-anchor spring constant
    damping: 0.82,
    particles: [] as Particle[],
    anchors: [] as { x: number, y: number }[],
    // Multi-touch & Motion state
    pointers: new Map<number, { x: number, y: number }>(),
    initialPinchDist: 0,
    initialBaseR: 45,
    tilt: { x: 0, y: 0 },
    ripples: [] as { x: number, y: number, r: number, alpha: number, color: string }[],
    lastTapTime: 0,
    // Audio State
    audioCtx: null as AudioContext | null,
    droneOsc: null as OscillatorNode | null,
    droneGain: null as GainNode | null,
    delayNode: null as DelayNode | null,
    delayFeedback: null as GainNode | null,
    // Idle Animation State
    idleTime: 0,
    startPos: [] as { x: number, y: number }[],
    // Spectrum FX
    ghosts: [] as { x: number, y: number, r: number, hue: number, alpha: number }[],
    hueCycle: 0,
  });

  const [motionActive, setMotionActive] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);

  // Audio Synthesis Utilities
  const initAudio = () => {
    if (stateRef.current.audioCtx) return;
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    stateRef.current.audioCtx = ctx;

    // Setup Delay Effect for Plucks
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.25; // Quarter note-ish
    const feedback = ctx.createGain();
    feedback.gain.value = 0.4; // Feedback amount

    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(ctx.destination);

    stateRef.current.delayNode = delay;
    stateRef.current.delayFeedback = feedback;

    setAudioEnabled(true);
  };

  const playPluck = (freq: number = 220) => {
    const ctx = stateRef.current.audioCtx;
    if (!ctx || ctx.state === 'suspended') return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, ctx.currentTime + 0.2);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2000, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.2);

    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    // Connect to delay line
    if (stateRef.current.delayNode) {
      gain.connect(stateRef.current.delayNode);
    }

    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  };

  const startDrone = () => {
    const ctx = stateRef.current.audioCtx;
    if (!ctx || ctx.state === 'suspended' || stateRef.current.droneOsc) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(110, ctx.currentTime);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(400, ctx.currentTime);

    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.1);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    stateRef.current.droneOsc = osc;
    stateRef.current.droneGain = gain;
  };

  const updateDrone = (dist: number) => {
    const { droneOsc, droneGain, audioCtx } = stateRef.current;
    if (!droneOsc || !droneGain || !audioCtx) return;

    const freq = 110 + (dist * 0.5);
    const volume = Math.min(0.2, (dist / 300) * 0.2);
    
    droneOsc.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.05);
    droneGain.gain.setTargetAtTime(volume, audioCtx.currentTime, 0.1);
  };

  const stopDrone = () => {
    const { droneOsc, droneGain, audioCtx } = stateRef.current;
    if (!droneOsc || !droneGain || !audioCtx) return;

    droneGain.gain.cancelScheduledValues(audioCtx.currentTime);
    droneGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.2);
    droneOsc.stop(audioCtx.currentTime + 0.2);

    stateRef.current.droneOsc = null;
    stateRef.current.droneGain = null;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const handleResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = w;
      canvas.height = h;
      const state = stateRef.current;
      state.cx = w / 2;
      state.cy = h / 2;
      
      // Update corner anchors
      state.anchors = [
        { x: 40, y: 40 },           // Top Left
        { x: w - 40, y: 40 },      // Top Right
        { x: 40, y: h - 40 },      // Bottom Left
        { x: w - 40, y: h - 40 }   // Bottom Right
      ];
      state.startPos = [...state.anchors];

      if (state.x === 0) {
        state.x = state.cx;
        state.y = state.cy;
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    const animate = (time: number) => {
      const state = stateRef.current;
      const { cx, cy, k, damping, baseR, anchors } = state;

      if (!state.isDragging) {
        state.idleTime += 16; // Approx 60fps increment
      } else {
        state.idleTime = 0;
      }

      // 1. Clear & Draw Background Grid
      ctx.fillStyle = '#0A0A0F';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.beginPath();
      for(let i = 0; i < canvas.width; i += 40) {
        ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height);
      }
      for(let j = 0; j < canvas.height; j += 40) {
        ctx.moveTo(0, j); ctx.lineTo(canvas.width, j);
      }
      ctx.stroke();

      // Draw Ripples
      state.ripples = state.ripples.map(r => ({
        ...r,
        r: r.r + 4,
        alpha: r.alpha - 0.03
      })).filter(r => r.alpha > 0);

      state.ripples.forEach(r => {
        ctx.save();
        ctx.strokeStyle = r.color;
        ctx.globalAlpha = Math.max(0, r.alpha);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      });

      // Update Hue & Spectrum Ghosts
      if (state.isDragging) {
        state.hueCycle = (state.hueCycle + 2) % 360;
        state.hue = state.hueCycle;
      }
      
      const speed = Math.hypot(state.vx, state.vy);
      if (speed > 10 || (state.isDragging && speed > 2)) {
        state.ghosts.push({
          x: state.x,
          y: state.y,
          r: state.baseR,
          hue: state.hue,
          alpha: 0.5
        });
      }
      
      state.ghosts = state.ghosts.map(g => ({
        ...g,
        alpha: g.alpha - 0.04,
        r: g.r * 0.99
      })).filter(g => g.alpha > 0);

      state.ghosts.forEach(g => {
        ctx.save();
        ctx.fillStyle = `hsla(${g.hue}, 100%, 70%, ${g.alpha})`;
        ctx.beginPath();
        ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      // 2. Draw Corner Hook UI with Idle Drift
      const isIdle = state.idleTime > 2000;
      anchors.forEach((anchor, i) => {
        if (isIdle && !state.isDragging && state.startPos[i]) {
          const driftX = Math.sin(time * 0.001 + i) * 10;
          const driftY = Math.cos(time * 0.0012 + i) * 10;
          anchor.x += (state.startPos[i].x + driftX - anchor.x) * 0.05;
          anchor.y += (state.startPos[i].y + driftY - anchor.y) * 0.05;
        }

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const size = 15;
        const offsetX = anchor.x < cx ? 1 : -1;
        const offsetY = anchor.y < cy ? 1 : -1;
        ctx.moveTo(anchor.x, anchor.y + size * offsetY);
        ctx.lineTo(anchor.x, anchor.y);
        ctx.lineTo(anchor.x + size * offsetX, anchor.y);
        ctx.stroke();

        ctx.fillStyle = (state.isDragging || (isIdle && Math.sin(time * 0.005 + i) > 0)) 
          ? 'rgba(34, 211, 238, 0.4)' 
          : 'rgba(255, 255, 255, 0.1)';
        ctx.beginPath();
        ctx.arc(anchor.x, anchor.y, 4, 0, Math.PI * 2);
        ctx.fill();
      });

      // 3. Multi-Vector Physics
      if (!state.isDragging) {
        anchors.forEach(anchor => {
          const dx = anchor.x - state.x;
          const dy = anchor.y - state.y;
          state.vx += dx * k;
          state.vy += dy * k;
        });

        const cdx = cx - state.x;
        const cdy = cy - state.y;
        state.vx += cdx * 0.05;
        state.vy += cdy * 0.05;

        state.vx += state.tilt.x * 0.6;
        state.vy += state.tilt.y * 0.6;

        state.vx *= damping;
        state.vy *= damping;
        state.x += state.vx;
        state.y += state.vy;
      }

      // 4. Draw Vector Connections (Hefboom Strings)
      const dist = Math.hypot(state.x - cx, state.y - cy);
      const angle = Math.atan2(state.y - cy, state.x - cx);

      ctx.save();
      anchors.forEach((anchor, i) => {
        const opacity = state.isDragging ? 0.4 : 0.05;
        const lineHue = (state.hueCycle + i * 40) % 360;
        ctx.strokeStyle = state.isDragging ? `hsla(${lineHue}, 100%, 70%, ${opacity})` : `rgba(255, 255, 255, ${opacity})`;
        ctx.lineWidth = state.isDragging ? 1.5 : 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(anchor.x, anchor.y);
        ctx.lineTo(state.x, state.y);
        ctx.stroke();
      });
      ctx.restore();

      // 5. Smooth Color Transitions
      state.lightness += (state.targetLightness - state.lightness) * 0.1;
      state.saturation += (state.targetSaturation - state.saturation) * 0.1;
      
      const pulse = isIdle ? Math.sin(time * 0.003) * 10 : 0;
      const highlightColor = state.isDragging 
        ? `hsl(${state.hueCycle}, 100%, 70%)` 
        : `rgb(${245 + pulse}, ${245 + pulse}, ${245 + pulse})`;
      
      ctx.save();
      ctx.shadowBlur = state.isDragging ? 50 : (15 + (isIdle ? (Math.sin(time * 0.003) + 1) * 10 : 0));
      ctx.shadowColor = highlightColor;
      ctx.fillStyle = highlightColor;

      // 6. Draw Elastic Blob
      if (dist > 5) {
        const tailR = Math.max(10, baseR - dist * 0.1);
        const pAngle = angle + Math.PI / 2;

        ctx.beginPath();
        ctx.arc(cx, cy, tailR, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(state.x, state.y, baseR, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(cx + tailR * Math.cos(pAngle), cy + tailR * Math.sin(pAngle));
        ctx.lineTo(cx + tailR * Math.cos(pAngle + Math.PI), cy + tailR * Math.sin(pAngle + Math.PI));
        ctx.lineTo(state.x + baseR * Math.cos(pAngle + Math.PI), state.y + baseR * Math.sin(pAngle + Math.PI));
        ctx.lineTo(state.x + baseR * Math.cos(pAngle), state.y + baseR * Math.sin(pAngle));
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(cx, cy, baseR + (isIdle ? Math.sin(time * 0.002) * 2 : 0), 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.shadowBlur = 0;
      ctx.fillStyle = "#0A0A0F";
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 7. Draw Particles
      ctx.save();
      ctx.textAlign = 'center';
      state.particles = state.particles.map(p => ({
        ...p,
        y: p.y + p.vy,
        x: p.x + p.vx,
        alpha: p.alpha - 0.015
      })).filter(p => p.alpha > 0);

      state.particles.forEach(p => {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.font = `bold 24px 'JetBrains Mono', monospace`;
        ctx.fillText(p.text, p.x, p.y);
      });
      ctx.restore();

      requestAnimationFrame(animate);
    };

    const handlePointerDown = (e: PointerEvent) => {
      const state = stateRef.current;
      state.idleTime = 0;
      state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      state.lastTapTime = Date.now();

      if (state.pointers.size === 1) {
        const d = Math.hypot(e.clientX - state.x, e.clientY - state.y);
        if (d < state.baseR * 2) {
          state.isDragging = true;
          state.vx = 0;
          state.vy = 0;
          state.maxDist = 0;
          state.targetLightness = 60;
          state.targetSaturation = 100;
          state.hue = Math.random() * 360;
          setIsInteractionActive(true);
          startDrone();
        }
      } else if (state.pointers.size === 2) {
        // Initialize pinch dist
        const pts = Array.from(state.pointers.values()) as { x: number; y: number }[];
        state.initialPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        state.initialBaseR = state.baseR;
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      const state = stateRef.current;
      state.idleTime = 0;
      if (!state.pointers.has(e.pointerId)) return;
      state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (state.pointers.size === 1 && state.isDragging) {
        state.x = e.clientX;
        state.y = e.clientY;
        const d = Math.hypot(state.x - state.cx, state.y - state.cy);
        state.maxDist = Math.max(state.maxDist, d);
        setMetrics(m => ({ ...m, input: Math.round(d) }));
        updateDrone(d);
      } else if (state.pointers.size === 2) {
        const pts = Array.from(state.pointers.values()) as { x: number; y: number }[];
        const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (state.initialPinchDist > 0) {
          const ratio = currentDist / state.initialPinchDist;
          state.baseR = Math.min(150, Math.max(20, state.initialBaseR * ratio));
        }
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      const state = stateRef.current;
      const wasDragging = state.isDragging;
      const duration = Date.now() - state.lastTapTime;
      const pt = state.pointers.get(e.pointerId);

      state.pointers.delete(e.pointerId);

      // Tap response
      if (!wasDragging && pt && duration < 250) {
        const d = Math.hypot(pt.x - state.x, pt.y - state.y);
        if (d < state.baseR * 1.5) {
          playPluck(330 + Math.random() * 220);
          // Trigger Ripple
          state.ripples.push({
            x: state.x,
            y: state.y,
            r: 10,
            alpha: 1,
            color: `hsl(${Math.random() * 360}, 100%, 70%)`
          });
          // Small physics impulse
          state.vx += (Math.random() - 0.5) * 20;
          state.vy += (Math.random() - 0.5) * 20;
          // Flash hue
          state.hue = Math.random() * 360;
          state.lightness = 70;
          state.saturation = 100;
        }
      }

      if (state.pointers.size === 0 && wasDragging) {
        state.isDragging = false;
        stopDrone();
        
        // Add visual echo pulse on release
        const releaseMag = Math.min(50, state.maxDist / 5);
        for(let i = 0; i < 6; i++) {
          state.ghosts.push({
            x: state.x + (Math.random() - 0.5) * releaseMag,
            y: state.y + (Math.random() - 0.5) * releaseMag,
            r: state.baseR * (1 + i * 0.1),
            hue: (state.hueCycle + i * 15) % 360,
            alpha: 0.8 - (i * 0.1)
          });
        }

        state.targetLightness = 25;
        state.targetSaturation = 0;
        
        const finalVal = Math.round(state.maxDist);
        setMetrics(m => ({ input: m.input, output: finalVal }));
        
        setTimeout(() => setMetrics(m => ({ ...m, input: 0 })), 500);

        if (finalVal > 20) {
          state.particles.push({
            id: Date.now(),
            x: state.cx,
            y: state.cy - 100,
            text: `+${finalVal}`,
            alpha: 1,
            color: '#f5d0fe', // Fuchsia-ish
            vx: (Math.random() - 0.5) * 2,
            vy: -2
          });
        }
      }

      if (state.pointers.size < 2) {
        state.initialPinchDist = 0;
      }
    };

    const handleOrientation = (e: DeviceOrientationEvent) => {
      if (e.beta !== null && e.gamma !== null) {
        stateRef.current.tilt = {
          x: e.gamma / 10,
          y: e.beta / 10
        };
      }
    };

    const enableMotion = async () => {
      if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
        try {
          const response = await (DeviceOrientationEvent as any).requestPermission();
          if (response === 'granted') {
            setMotionActive(true);
            window.addEventListener('deviceorientation', handleOrientation);
          }
        } catch (e) {
          console.error(e);
        }
      } else {
        setMotionActive(true);
        window.addEventListener('deviceorientation', handleOrientation);
      }
    };
    (window as any).enableMotion = enableMotion; // Expose for the button

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    // Don't auto-add orientation until enabled/granted on iOS
    if (typeof (DeviceOrientationEvent as any).requestPermission !== 'function') {
       window.addEventListener('deviceorientation', handleOrientation);
    }

    const animationId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('deviceorientation', handleOrientation);
    };
  }, []);

  const tensionPercent = Math.min(100, (metrics.input / 300) * 100);
  const forcePercent = Math.min(100, (metrics.output / 300) * 100);

  return (
    <div className="fixed inset-0 bg-[#0A0A0F] text-white font-mono overflow-hidden select-none touch-none">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-crosshair"
      />

      {/* HUD Container */}
      <div className="absolute top-10 left-1/2 -translate-x-1/2 flex items-center gap-12 z-20 w-full justify-center px-6">
        {/* Tension Panel */}
        <div className="flex flex-col items-center w-48">
          <span className="text-[10px] tracking-[0.3em] text-slate-500 mb-2 uppercase">Input Tension</span>
          <div className="text-5xl font-light tracking-tighter tabular-nums">
            {metrics.input.toString().padStart(3, '0')}
          </div>
          <div className="w-full h-1 bg-slate-800 mt-4 overflow-hidden rounded-full">
            <div 
              style={{ width: `${tensionPercent}%` }}
              className="h-full bg-cyan-400 transition-all duration-75 shadow-[0_0_8px_rgba(34,211,238,0.5)]" 
            />
          </div>
        </div>

        {/* Divider */}
        <div className="h-16 w-px bg-slate-800 self-center" />

        {/* Output Panel */}
        <div className="flex flex-col items-center w-48">
          <span className="text-[10px] tracking-[0.3em] text-slate-500 mb-2 uppercase">Output Kinetic</span>
          <div className="text-5xl font-light tracking-tighter text-fuchsia-500 tabular-nums">
            {metrics.output.toString().padStart(3, '0')}
          </div>
          <div className="w-full h-1 bg-slate-800 mt-4 overflow-hidden rounded-full">
            <div 
              style={{ width: `${forcePercent}%` }}
              className="h-full bg-fuchsia-500 transition-all duration-75 shadow-[0_0_8px_rgba(217,70,239,0.5)]" 
            />
          </div>
        </div>
      </div>

      {/* Footer Left */}
      <div className="absolute bottom-10 left-10 text-[10px] text-slate-600 tracking-widest uppercase flex flex-col gap-2 pointer-events-none">
        <div className="flex items-center gap-3">
          <span>System: <span className={isInteractionActive ? "text-cyan-500" : "text-slate-600"}>Active</span></span>
          <div className="w-1 h-1 rounded-full bg-slate-800" />
          <span>Motion: <span className={motionActive ? "text-fuchsia-500" : "text-slate-600"}>{motionActive ? "ON" : "OFF"}</span></span>
          <div className="w-1 h-1 rounded-full bg-slate-800" />
          <span>Audio: <span className={audioEnabled ? "text-cyan-400" : "text-slate-600"}>{audioEnabled ? "ON" : "OFF"}</span></span>
        </div>
        <div>Mode: Elastic Catapult</div>
        <div className="animate-pulse">Status: {stateRef.current.isDragging ? 'Calibrating...' : 'Awaiting Interaction'}</div>
        <div className="flex gap-2 mt-2">
          {!motionActive && (
            <button 
              onClick={() => (window as any).enableMotion?.()}
              className="pointer-events-auto px-3 py-1 bg-white/5 border border-white/10 hover:bg-white/10 transition-colors text-[9px]"
            >
              Enable Motion
            </button>
          )}
          {!audioEnabled && (
            <button 
              onClick={initAudio}
              className="pointer-events-auto px-3 py-1 bg-white/5 border border-white/10 hover:bg-white/10 transition-colors text-[9px]"
            >
              Enable Audio
            </button>
          )}
        </div>
      </div>

      {/* Footer Right */}
      <div className="absolute bottom-10 right-10 text-right text-[10px] text-slate-600 tracking-widest uppercase pointer-events-none flex flex-col gap-1">
        <div>Vector Balance Engine v1.0.6</div>
        <div>Pinch to Stretch Weight</div>
        <div>Tilt to Shift Gravity</div>
        <div className="text-cyan-400/50">Spectrum FX Enabled</div>
      </div>
    </div>
  );
}

