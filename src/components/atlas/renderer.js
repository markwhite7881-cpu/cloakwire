import * as d3 from "d3-geo";
import * as topojson from "topojson-client";
import world from "./world-110m.json";
import labels from "./countries.json";

export function mountGlobe(scene, countryName) {
  const canvas = scene.querySelector('canvas');
  const label = scene.querySelector('.ah-label');
  const context = canvas.getContext('2d');
  if (!context) return { syncProfiles() {}, setProfile() {}, trafficRise() {}, destroy() {} };
  const topology = world.objects.features;
  const land = topojson.merge(world, topology.geometries);
  const borders = topojson.mesh(world, topology, (a,b) => a !== b);
  const grid = d3.geoGraticule().step([30,30])();
  const projection = d3.geoOrthographic().clipAngle(90).precision(.7);
  const path = d3.geoPath(projection, context);
  const vectorPath = d3.geoPath(projection);
  const overlay = scene.querySelector('.ah-globe-fx');
  const clip = overlay.querySelector('clipPath circle');
  const light = overlay.querySelector('.ah-light-sweep');
  const edge = overlay.querySelector('.ah-line-edge');
  const outline = overlay.querySelector('.ah-line-pulse');
  const wave = overlay.querySelector('.ah-line-wave');
  let lastWaveAt = -Infinity;
  const locations = new Map();
  function syncProfiles(list) {
   locations.clear();
   for (const code of list) {
    const entry = labels[code];
    if (!entry) continue;
    const geometry = topology.geometries.find(g => g.properties.id === entry.iso);
    locations.set(code, {...entry, code, name:countryName(code), shape:geometry ? topojson.feature(world,geometry) : null});
   }
   if(!locations.has(calloutCode))calloutCode=null;
  }


  let center = [11,28], focus = null, connected = false, flight = null;
  let width = 0, height = 0, radius = 0, raf = 0, previous = null, onScreen = true;
  const calloutInterval = 12;
  const lastShownAt = new Map();
  let idleSeconds = 0, calloutStartedAt = -Infinity, calloutCode = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const visible = () => onScreen && !document.hidden;
  const paint={
    ocean:[[0,'#70859c'],[.64,'#425875'],[1,'#273a53']],
    land:[[0,'#cbd7e1'],[.64,'#a8b9cb'],[1,'#77899d']]
  };

  function ringPath(x,y,r) {
    return 'M'+(x+r)+' '+y+'a'+r+' '+r+' 0 1 1 '+(-2*r)+' 0a'+r+' '+r+' 0 1 1 '+(2*r)+' 0Z';
  }
  function updateOverlay(){
    if(!connected||flight){scene.dataset.effect='none';return;}
    if(!focus){scene.dataset.effect='light';return;}
    let contour,track;
    if(focus.shape && vectorPath.area(focus.shape)>=24){
      contour=vectorPath(focus.shape);
      // Traverse one continuous coast even when the full outline contains many islands.
      const geometry=focus.shape.geometry;
      const polygons=geometry.type==='MultiPolygon'?geometry.coordinates:[geometry.coordinates];
      const largest=polygons.map(coordinates=>({coordinates,area:vectorPath.area({type:'Polygon',coordinates})})).sort((a,b)=>b.area-a.area)[0].coordinates;
      track=vectorPath({type:'LineString',coordinates:largest[0]});
    }else{
      const [x,y]=projection(focus.coords);
      contour=track=ringPath(x,y,5.5);
    }
    edge.setAttribute('d',contour);outline.setAttribute('d',contour);
    wave.setAttribute('d',track);
    if(scene.dataset.effect!=='wave')scene.dataset.effect='contour';
  }
  function trafficRise() {
    if(reduced.matches||!visible()||scene.dataset.effect!=='contour')return;
    const now=performance.now();
    if(now-lastWaveAt<12000)return;
    lastWaveAt=now;scene.dataset.effect='wave';
  }
  function endWave(){
    if(scene.dataset.effect==='wave')scene.dataset.effect='contour';
  }
  wave.addEventListener('animationend',endWave);
  wave.addEventListener('animationcancel',endWave);

  function drawShape(shape, fill, stroke, weight) {
    context.beginPath();
    path(shape);
    if (fill) { context.fillStyle=fill; context.fill(); }
    if (stroke) { context.strokeStyle=stroke; context.lineWidth=weight; context.stroke(); }
  }
  function shade(colors,cx,cy) {
    const g=context.createRadialGradient(cx-radius*.44,cy-radius*.52,radius*.05,cx,cy,radius*1.12);
    colors.forEach(([stop,color])=>g.addColorStop(stop,color));
    return g;
  }
  function chooseCallout() {
    if (connected) return {location:focus,opacity:1};
    if (idleSeconds-calloutStartedAt>=calloutInterval && locations.size) {
      calloutStartedAt=idleSeconds;
      const front=[...locations.values()].filter(location=>d3.geoDistance(center,location.coords)<1.36)
        .sort((a,b)=>{
          const ageOrder=(lastShownAt.get(a.code)??-1)-(lastShownAt.get(b.code)??-1);
          return ageOrder || d3.geoDistance(center,a.coords)-d3.geoDistance(center,b.coords);
        });
      calloutCode=front[0]?.code;
      if(calloutCode)lastShownAt.set(calloutCode,idleSeconds);
    }
    const t=idleSeconds-calloutStartedAt;
    return {location:locations.get(calloutCode),opacity:Math.max(0,Math.min(1,(t+.1)/.45,(4.4-t)/.5))};
  }
  function draw() {
    if (!radius) return;
    const cx=width/2,cy=height/2-1;
    projection.translate([cx,cy]).scale(radius).rotate([-center[0],-center[1]]);
    context.clearRect(0,0,width,height);
    context.save();
    context.beginPath();context.arc(cx,cy,radius,0,Math.PI*2);context.clip();
    context.fillStyle=shade(paint.ocean,cx,cy);
    context.fillRect(cx-radius,cy-radius,radius*2,radius*2);
    drawShape(land,shade(paint.land,cx,cy));
    drawShape(borders,null,'rgba(25,40,54,.42)',.52);
    drawShape(grid,null,'rgba(246,250,255,.22)',.5);
    context.restore();
    updateOverlay();
    const {location,opacity}=chooseCallout();
    if (location && d3.geoDistance(center,location.coords)<1.45 && opacity>0) {
      const caption=countryName(location.code);
      if(label.textContent!==caption)label.textContent=caption;
      const [x,y]=projection(location.coords);
      const left=Math.max(1,Math.min(width-label.offsetWidth-1,x-label.offsetWidth/2));
      label.style.transform='translate('+left.toFixed(1)+'px,'+Math.max(1,y+5).toFixed(1)+'px)';
      label.style.opacity=String(opacity);
    } else label.style.opacity='0';
    canvas.dataset.center=center.map(n=>n.toFixed(4)).join(',');
  }
  function schedule() {
    if (!raf && visible() && (flight || !connected)) raf=requestAnimationFrame(frame);
  }
  function frame(now) {
    raf=0;
    if (!visible()) {previous=null;return;}
    const dt=previous===null?0:(now-previous)/1000;
    if(previous!==null && dt<1/32){schedule();return;}
    previous=now;
    const step=Math.min(dt,.12);
    if (flight) {
      flight.elapsed+=step;
      const t=Math.min(1,flight.elapsed/flight.duration);
      center=flight.path(t*t*(3-2*t));
      if(t===1){center=[...focus.coords];flight=null;}
    } else if (!connected) {
      // Keep the idle globe moving, even when the last connection chose a server.
      const period=reduced.matches?180:120;
      center=[(center[0]+360*step/period+540)%360-180,center[1]+(26-center[1])*Math.min(1,step*.23)];
      idleSeconds+=dt;
    }
    draw();schedule();
  }
  function restart() {
    cancelAnimationFrame(raf);raf=0;previous=null;
    scene.toggleAttribute('data-visible',visible());
    if(visible()){draw();schedule();}
  }
  function setProfile(country, running) {
    if(!running && !connected){
      if(visible())draw();
      return;
    }
    scene.dataset.effect='none';
    if(connected && !running)calloutCode=null;
    connected=running;focus=running?(locations.get(country)||null):null;flight=null;
    if(focus) {
      const angle=d3.geoDistance(center,focus.coords);
      if (reduced.matches || !visible() || angle<.0001) center=[...focus.coords];
      else flight={elapsed:0,duration:.6+.3*angle/Math.PI,path:d3.geoInterpolate(center,focus.coords)};
    }
    restart();
  }
  function resize() {
    width=scene.clientWidth;height=scene.clientHeight;
    const ratio=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);context.setTransform(ratio,0,0,ratio,0,0);
    radius=Math.max(1,Math.min(width*.46,height*.455));
    overlay.setAttribute('viewBox','0 0 '+Math.max(width,1)+' '+Math.max(height,1));
    const cx=width/2,cy=height/2-1;
    clip.setAttribute('cx',cx);clip.setAttribute('cy',cy);clip.setAttribute('r',radius);
    light.setAttribute('cx',cx-radius*.20);light.setAttribute('cy',cy-radius*.34);
    light.setAttribute('rx',radius*.86);light.setAttribute('ry',radius*.74);
    overlay.style.setProperty('--light-travel',radius*.48+'px');
    draw();
  }
  const resizeObserver=new ResizeObserver(resize);
  const intersectionObserver=new IntersectionObserver(entries=>{onScreen=entries.at(-1).isIntersecting;restart();});
  resizeObserver.observe(scene);
  intersectionObserver.observe(scene);
  document.addEventListener('visibilitychange',restart);
  const motionChanged=()=>{if(flight && reduced.matches){flight=null;center=[...focus.coords];}restart();};
  reduced.addEventListener('change',motionChanged);
  resize();restart();
  return {setProfile,trafficRise,syncProfiles,destroy(){
    cancelAnimationFrame(raf);onScreen=false;
    resizeObserver.disconnect();intersectionObserver.disconnect();
    document.removeEventListener('visibilitychange',restart);reduced.removeEventListener('change',motionChanged);
    wave.removeEventListener('animationend',endWave);wave.removeEventListener('animationcancel',endWave);
  }};
}
