import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w * 0.99999;
}`;

const FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uMoonDir;
uniform float uNight;
uniform float uTime;
uniform float uCloud;
uniform float uEnv;
uniform float uScatter;
varying vec3 vDir;

float h12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float vnoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( h12( i ), h12( i + vec2( 1.0, 0.0 ) ), u.x ), mix( h12( i + vec2( 0.0, 1.0 ) ), h12( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float fbm( vec2 p ) {
  float s = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 5; i ++ ) {
    s += a * vnoise( p );
    p = p * 2.07 + vec2( 17.1, 9.2 );
    a *= 0.5;
  }
  return s;
}
float h13( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}

void main() {
  vec3 d = normalize( vDir );
  float y = d.y;
  float yc = max( y, 0.0 );
  float day = 1.0 - uNight;
  float mu = dot( d, uSunDir );
  float mup = max( mu, 0.0 );
  // The horizon colour is exactly what the fog shader produces at full density, so distant terrain melts into it.
  vec3 hz = uHorizon + uSunColor * uScatter * ( pow( mup, 8.0 ) * 0.7 + pow( mup, 40.0 ) * 0.6 );
  vec3 col = mix( hz, uZenith, pow( yc, 0.42 ) );
  // Mie scattering around the sun above the horizon line.
  float above = smoothstep( 0.0, 0.08, yc );
  col += uSunColor * ( pow( mup, 5.0 ) * 0.22 * uScatter + pow( mup, 32.0 ) * 0.4 + pow( mup, 400.0 ) * 1.5 ) * day * mix( 1.0, 0.65, yc ) * above;
  // Dust band hugging the horizon.
  col = mix( col, hz, exp( - yc * 16.0 ) * 0.55 );
  // Clouds: two fbm layers projected on a dome, lit from the sun side.
  if ( y > 0.0 && uCloud > 0.0 ) {
    vec2 uv = d.xz / ( y * 1.4 + 0.1 );
    vec2 drift = vec2( uTime * 0.0035, uTime * 0.0012 );
    float n = fbm( uv * 0.75 + drift );
    float n2 = fbm( uv * 2.6 - drift * 1.6 + n );
    float dens = n * 0.75 + n2 * 0.45;
    float c = smoothstep( 0.78 - uCloud * 0.32, 0.98 - uCloud * 0.32, dens );
    c *= smoothstep( 0.0, 0.16, y );
    float thick = smoothstep( 0.8, 1.25, dens );
    float lit = 0.55 + 0.45 * pow( mup, 1.5 );
    vec3 shadeCol = mix( uHorizon * 0.62 + uZenith * 0.12, uHorizon * 0.95 + uSunColor * 0.35, lit );
    shadeCol *= 1.0 - thick * 0.35;
    shadeCol += uSunColor * pow( mup, 10.0 ) * ( 1.0 - thick ) * 1.4 * day;
    shadeCol = mix( shadeCol, uZenith * 0.5 + uHorizon * 0.2, uNight * 0.85 );
    col = mix( col, shadeCol, c * 0.9 );
  }
  // Ground below the horizon (seen in reflections and from cliff tops).
  float g = smoothstep( 0.0, -0.06, y );
  col = mix( col, uGround, g );
  // HDR sun disc, left out of the environment capture so reflections don't double the sun light.
  float disc = smoothstep( 0.99962, 0.9998, mu ) * day * ( 1.0 - uEnv ) * ( 1.0 - g );
  col += uSunColor * disc * 60.0;
  if ( uNight > 0.01 ) {
    vec3 sp = floor( d * 240.0 );
    float tw = 0.6 + 0.4 * sin( uTime * 2.3 + h13( sp + 3.1 ) * 40.0 );
    float s = step( 0.9983, h13( sp ) ) * smoothstep( 0.03, 0.35, y ) * tw;
    col += vec3( 0.85, 0.9, 1.0 ) * s * uNight * 3.0 * ( 1.0 - uEnv );
    float md = dot( d, uMoonDir );
    col += vec3( 0.75, 0.8, 0.95 ) * ( smoothstep( 0.99935, 0.9996, md ) * 5.0 * ( 1.0 - uEnv ) + pow( max( md, 0.0 ), 24.0 ) * 0.06 ) * uNight;
  }
  gl_FragColor = vec4( col, 1.0 );
}`;

/**
 * Analytic sky dome with sun glow, drifting clouds, stars and a moon. It also renders itself into a small
 * cube map that is prefiltered (PMREM) into the scene's environment: every PBR surface is lit and reflects
 * the same sky the player sees.
 */
export class SkyDome {
  mesh: THREE.Mesh;
  uniforms = {
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
    uSunColor: { value: new THREE.Color(1, 0.85, 0.65) },
    uZenith: { value: new THREE.Color(0.2, 0.35, 0.7) },
    uHorizon: { value: new THREE.Color(0.8, 0.75, 0.65) },
    uGround: { value: new THREE.Color(0.25, 0.2, 0.15) },
    uMoonDir: { value: new THREE.Vector3(-0.3, 0.6, -0.7).normalize() },
    uNight: { value: 0 },
    uTime: { value: 0 },
    uCloud: { value: 0.35 },
    uEnv: { value: 0 },
    uScatter: { value: 0.5 },
  };
  private material: THREE.ShaderMaterial;
  private envScene = new THREE.Scene();
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCam: THREE.CubeCamera;
  private pmrem: THREE.PMREMGenerator | null = null;
  envRT: THREE.WebGLRenderTarget | null = null;
  private lastSig: number[] = [];
  private envAge = 999;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 20), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    const envMesh = new THREE.Mesh(this.mesh.geometry, this.material);
    envMesh.frustumCulled = false;
    this.envScene.add(envMesh);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(1, 3000, this.cubeRT);
  }

  /**
   * Re-capture the environment when the sky has changed enough, at most every `minAge` seconds.
   * Returns the prefiltered texture to assign to `scene.environment`.
   */
  updateEnv(gl: THREE.WebGLRenderer, dt: number, minAge = 0.75): THREE.Texture | null {
    this.envAge += dt;
    const u = this.uniforms;
    const sig = [u.uSunDir.value.x, u.uSunDir.value.y, u.uSunDir.value.z, u.uSunColor.value.r, u.uSunColor.value.g, u.uZenith.value.b, u.uHorizon.value.r, u.uHorizon.value.g, u.uNight.value, u.uCloud.value];
    let diff = this.lastSig.length ? 0 : 1;
    for (let i = 0; i < this.lastSig.length; i++) diff = Math.max(diff, Math.abs(sig[i] - this.lastSig[i]));
    if (this.envRT && (diff < 0.01 || this.envAge < minAge)) return this.envRT.texture;
    this.lastSig = sig;
    this.envAge = 0;
    if (!this.pmrem) {
      this.pmrem = new THREE.PMREMGenerator(gl);
      this.pmrem.compileCubemapShader();
    }
    u.uEnv.value = 1;
    this.cubeCam.update(gl, this.envScene);
    u.uEnv.value = 0;
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT);
    return this.envRT.texture;
  }

  dispose() {
    this.cubeRT.dispose();
    this.envRT?.dispose();
    this.pmrem?.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
