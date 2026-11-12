import {BufferGeometry} from 'three';

// Three's setFromPoints updates an existing attribute in place. Its vertex
// count must match, or growth truncates the route and shrinkage keeps old data.
export function updateRouteGeometry(line,points){
 if(line.geometry.getAttribute('position')?.count!==points.length){
  const previous=line.geometry;
  line.geometry=new BufferGeometry();
  previous.dispose();
 }
 line.geometry.setFromPoints(points);
 line.geometry.setDrawRange(0,points.length);
 line.geometry.computeBoundingSphere();
}
