// CRT post-process in one fullscreen WebGL pass. Two modes:
// - 'source': samples a 2D canvas (the phone games) and outputs the warped, aberrated, scanlined image
// - 'overlay': draws a transparent layer over DOM (the host) that darkens, tints and glitches what's below

export interface CrtState {
  /** 0..1, grows as team health falls */
  damage: number
  /** 0..1 decaying pulse, set on misses */
  glitch: number
  /** 0..1 decaying pulse, set on hits */
  flash: number
  flashColor: [number, number, number]
}

/** 0 (clean) at 90+ HP up to 1 at 15 HP, eased; matches the audio degradation curve. */
export const damageFromHealth = (hp: number) => {
  const x = Math.max(0, Math.min(1, (90 - hp) / 75))
  return x * x * (3 - 2 * x)
}

// The handheld LCD is flat; only the host's overlay bulges.
export const CURVE = { source: 0, overlay: 0.1 }

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform float uDamage;
uniform float uGlitch;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uCurve;
uniform float uPx;
uniform sampler2D uTex;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec2 warp(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec2 off = abs(uv.yx) * uCurve;
  uv += uv * off * off * 4.0;
  return uv * 0.5 + 0.5;
}

void main() {
  vec2 uv = warp(vUv);
  float g = clamp(uGlitch + uDamage * 0.25 * step(0.93, hash(vec2(floor(uTime * 6.0), 7.0))), 0.0, 1.0);
#ifdef SOURCE
  float tornRows = 0.55;
  float dmgDark = 1.0;
#else
  // Over the host UI it has to stay readable on a TV: fewer torn rows, lighter darkening.
  g = min(g, 0.6);
  float tornRows = 0.3;
  float dmgDark = 0.4;
#endif

  // Torn horizontal bands: random rows slide sideways while glitching.
  float row = floor(uv.y * 28.0);
  float tick = floor(uTime * 24.0);
  float torn = step(1.0 - g * tornRows, hash(vec2(row, tick)));
  uv.x += (hash(vec2(row * 1.3, tick + 1.0)) - 0.5) * 0.12 * g * torn;

  float ca = (0.0012 + uDamage * 0.004 + g * 0.014);
  float outside = step(1.0, max(abs(uv.x - 0.5), abs(uv.y - 0.5)) * 2.0);

  // Scanlines every ~3 css px, deeper as the cartridge dies.
  float scan = 0.5 + 0.5 * sin(gl_FragCoord.y / uPx * 3.14159 * 0.66);
  float dark = scan * (0.18 + uDamage * 0.12 * dmgDark);
  vec2 v = vUv * 2.0 - 1.0;
  dark += smoothstep(0.55, 1.45, length(v * vec2(0.9, 1.0))) * (0.6 + uDamage * 0.25 * dmgDark);

  // Rolling bright band and grain.
  float roll = smoothstep(0.0, 0.04, abs(fract(vUv.y * 0.5 - uTime * 0.12) - 0.5) - 0.46);
  float grain = hash(gl_FragCoord.xy / uPx + fract(uTime * 13.0) * 100.0);
  float noiseAmt = 0.03 + (uDamage * 0.1 + g * 0.35) * dmgDark;

  vec3 add = uFlashColor * uFlash * 0.22 * (1.0 - length(v) * 0.4);
  add += vec3(1.0) * (grain - 0.5) * noiseAmt * (grain > 0.5 ? 1.0 : 0.0);
  add += vec3(0.03, 0.05, 0.06) * roll * (1.0 + uDamage);

#ifdef SOURCE
  // Phone games draw bright-on-dark; the handheld LCD shows that brightness as dark ink on pea green,
  // with the soft offset ghost real LCDs have.
  vec3 lcd = vec3(0.655, 0.706, 0.541);
  vec3 ink = vec3(0.149, 0.2, 0.11);
  vec3 s0;
  s0.r = texture2D(uTex, uv + vec2(ca, 0.0)).r;
  s0.g = texture2D(uTex, uv).g;
  s0.b = texture2D(uTex, uv - vec2(ca, 0.0)).b;
  vec3 s1 = texture2D(uTex, uv - vec2(3.0, -3.0) / uRes * uPx).rgb;
  float l = smoothstep(0.1, 0.7, max(max(s0.r, s0.g), s0.b));
  float gh = smoothstep(0.1, 0.7, max(max(s1.r, s1.g), s1.b));
  vec3 col = mix(lcd, ink, gh * 0.2);
  col = mix(col, ink, l);
  // Pixel grid every 3 css px, and a slow dim as the cartridge dies.
  vec2 cell = mod(gl_FragCoord.xy / uPx, 3.0);
  col *= 1.0 - 0.06 * (step(cell.x, 1.0) + step(cell.y, 1.0));
  col *= 1.0 - clamp(dark * 0.35, 0.0, 0.5);
  col = mix(col, ink, clamp(uFlash * 0.12, 0.0, 0.2));
  col += add * 0.5;
  col = mix(col, lcd, outside);
  gl_FragColor = vec4(col, 1.0);
#else
  // Over DOM we can't resample what's below, so glitch shows as coloured split fringes on torn rows.
  add += vec3(1.0, 0.1, 0.35) * torn * g * 0.1 * step(0.5, hash(vec2(row, tick + 3.0)));
  add += vec3(0.1, 0.9, 1.0) * torn * g * 0.1 * step(0.5, hash(vec2(row, tick + 5.0)));
  float a = clamp(dark + outside, 0.0, 1.0);
  gl_FragColor = vec4(max(add, 0.0) * (1.0 - outside), a);
#endif
}`

/** The same barrel warp the shader uses, for mapping taps on the warped image back to game space. */
export function warp(x: number, y: number, curve: number): [number, number] {
  const u = x * 2 - 1
  const v = y * 2 - 1
  const ox = Math.abs(v) * curve
  const oy = Math.abs(u) * curve
  return [(u + u * ox * ox * 4) * 0.5 + 0.5, (v + v * oy * oy * 4) * 0.5 + 0.5]
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export class Crt {
  private gl: WebGLRenderingContext
  private prog: WebGLProgram | null = null
  private tex: WebGLTexture | null = null
  private u: Record<string, WebGLUniformLocation | null> = {}
  /** Mobile browsers drop GL contexts when backgrounded or under memory pressure; skip frames until it's back. */
  private lost = false

  private constructor(readonly canvas: HTMLCanvasElement, gl: WebGLRenderingContext, readonly mode: 'source' | 'overlay') {
    this.gl = gl
    this.init()
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
  }

  private onLost = (e: Event) => {
    e.preventDefault()
    this.lost = true
  }

  private onRestored = () => {
    this.lost = false
    this.tex = null
    this.u = {}
    try {
      this.init()
    } catch {
      this.lost = true
    }
  }

  private init() {
    const { gl, mode } = this
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, (mode === 'source' ? '#define SOURCE\n' : '') + FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link')
    this.prog = prog
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    for (const name of ['uRes', 'uTime', 'uDamage', 'uGlitch', 'uFlash', 'uFlashColor', 'uCurve', 'uPx', 'uTex']) {
      this.u[name] = gl.getUniformLocation(prog, name)
    }
    if (mode === 'source') {
      this.tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.uniform1i(this.u.uTex, 0)
    }
  }

  /** Null when WebGL isn't available (or the shader fails); callers fall back to CSS. */
  static create(canvas: HTMLCanvasElement, mode: 'source' | 'overlay'): Crt | null {
    try {
      const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: mode === 'overlay', antialias: false })
      return gl && !gl.isContextLost() ? new Crt(canvas, gl, mode) : null
    } catch {
      return null
    }
  }

  render(time: number, s: CrtState, source?: TexImageSource) {
    if (this.lost) return
    const { gl, u } = this
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    if (source && this.tex) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height)
    gl.uniform1f(u.uTime, time)
    gl.uniform1f(u.uDamage, s.damage)
    gl.uniform1f(u.uGlitch, s.glitch)
    gl.uniform1f(u.uFlash, s.flash)
    gl.uniform3f(u.uFlashColor, ...s.flashColor)
    gl.uniform1f(u.uCurve, CURVE[this.mode])
    gl.uniform1f(u.uPx, devicePixelRatio || 1)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** Frees GL objects but keeps the context, since React may reuse the same canvas. */
  destroy() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    if (this.lost) return
    if (this.prog) this.gl.deleteProgram(this.prog)
    if (this.tex) this.gl.deleteTexture(this.tex)
  }
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** Decaying shake/glitch/flash envelopes shared by host and phone. */
export class Juice {
  trauma = 0
  glitch = 0
  flash = 0
  flashColor: [number, number, number] = [1, 1, 1]
  private reduced = reducedMotion()

  shake(amount: number) {
    if (!this.reduced) this.trauma = Math.min(1, this.trauma + amount)
  }

  hitGlitch(amount: number) {
    this.glitch = Math.min(1, this.glitch + amount * (this.reduced ? 0.3 : 1))
  }

  hitFlash(color: string, amount = 0.6) {
    this.flash = Math.min(1, this.flash + amount)
    this.flashColor = hexToRgb(color)
  }

  /** Advance by dt seconds; returns a pixel offset + rotation for the shake. */
  step(dt: number, maxPx = 14) {
    this.trauma = Math.max(0, this.trauma - dt * 1.6)
    this.glitch = Math.max(0, this.glitch - dt * 3)
    this.flash = Math.max(0, this.flash - dt * 4)
    const s = this.trauma * this.trauma
    const t = performance.now() / 1000
    return {
      x: s * maxPx * Math.sin(t * 71.3 + Math.sin(t * 13.1)),
      y: s * maxPx * Math.sin(t * 59.7 + 1.7),
      rot: s * 1.5 * Math.sin(t * 43.1),
    }
  }
}
