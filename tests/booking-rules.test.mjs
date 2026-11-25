// Run with: npm test   (checks prices, the Fri/Sat rule and whole-villa vs room clashes)
import assert from 'assert/strict';
import * as R from '../lib/booking-rules.js';
const villa={id:'v',bookingMode:'rooms',capacity:8,pricing:{weekday:13000,weekend:13000},
 rooms:[{id:'a',name:'Balcony Family Room',capacity:3,price:{weekday:4500}},{id:'b',name:'Family Bedroom',capacity:3,price:{weekday:4000}},{id:'c',name:'Double Bedroom',capacity:2,price:{weekday:2500}}],
 seasons:[{name:'Year-end',from:'2026-12-10',to:'2027-01-06',pricing:{weekday:15000,weekend:16000},roomPrices:{a:{weekday:5000}}}], promos:[{code:'X10',discount:10,from:'2026-01-01',to:'2027-12-31'}]};
// 2026-12-04 is a Friday
assert.equal(R.isWeekendNight('2026-12-04'),true); assert.equal(R.isWeekendNight('2026-12-06'),false);
assert.deepEqual(R.eachNight('2026-12-01','2026-12-04'),['2026-12-01','2026-12-02','2026-12-03']);
const rooms={type:'rooms',rooms:['a','c']};
// weekday rooms Tue-Thu
let q=R.quote(villa,rooms,'2026-12-01','2026-12-03'); assert.equal(q.total,2*(4500+2500));
// weekend rooms blocked
assert.match(R.validateBooking(villa,[],rooms,'2026-12-03','2026-12-05'),/Friday and Saturday/);
// Thu night ending Fri morning is fine
assert.equal(R.validateBooking(villa,[],rooms,'2026-12-03','2026-12-04'),null);
// admin switch
assert.equal(R.validateBooking({...villa,roomBooking:{allowOnWeekends:true}},[],rooms,'2026-12-03','2026-12-05'),null);
// whole villa weekend ok
assert.equal(R.validateBooking(villa,[],{type:'whole'},'2026-12-04','2026-12-06'),null);
// conflicts: room a booked blocks whole and room a, not room b
const P=[{from:'2026-12-01',to:'2026-12-03',units:['a']}];
assert.match(R.validateBooking(villa,P,{type:'whole'},'2026-12-02','2026-12-03'),/just been booked/);
assert.match(R.validateBooking(villa,P,{type:'rooms',rooms:['a']},'2026-12-02','2026-12-03'),/just been booked/);
assert.equal(R.validateBooking(villa,P,{type:'rooms',rooms:['b']},'2026-12-02','2026-12-03'),null);
// whole booking blocks rooms; legacy period without units = whole
assert.match(R.validateBooking(villa,[{from:'2026-12-01',to:'2026-12-02'}],{type:'rooms',rooms:['b']},'2026-12-01','2026-12-02'),/just been booked/);
// checkout on a booked night is fine
assert.equal(R.validateBooking(villa,[{from:'2026-12-03',to:'2026-12-04'}],{type:'whole'},'2026-12-01','2026-12-03'),null);
// season pricing & promo
q=R.quote(villa,{type:'whole'},'2026-12-09','2026-12-12','x10');
// 12-09 Wed base 13000, 12-10 Thu season 15000, 12-11 Fri season weekend 16000
assert.equal(q.subtotal,13000+15000+16000); assert.equal(q.discount,4400); assert.equal(q.total,39600);
q=R.quote(villa,{type:'rooms',rooms:['a','b']},'2026-12-14','2026-12-15'); assert.equal(q.total,5000+4000);
assert.equal(R.quote(villa,{type:'whole'},'2026-12-01','2026-12-02','NOPE').invalidPromo,true);
// non-room stay ignores room selection
const simple={pricing:{weekday:2700,weekend:3700}}; assert.equal(R.quote(simple,rooms,'2026-12-04','2026-12-06').total,7400);
assert.equal(R.capacityFor(villa,rooms),5); assert.equal(R.selectionLabel(villa,rooms),'Balcony Family Room + Double Bedroom');
assert.equal(R.fromPrice(villa),2500);
assert.equal(R.walkingMinutes({lat:11.9348,lng:79.8298},{lat:11.9330,lng:79.8355}), Math.ceil(R.distanceMeters({lat:11.9348,lng:79.8298},{lat:11.9330,lng:79.8355})*1.3/80));
assert.equal(R.walkingMinutes({lat:0,lng:0},{lat:1,lng:1,walkMinutes:5}),5);
assert.equal(R.activeFestiveTheme([{theme:'christmas',from:'2026-12-15',to:'2026-12-31'}],'2026-12-20'),'christmas');
assert.equal(R.activeFestiveTheme([{theme:'christmas',from:'2026-12-15',to:'2026-12-31',enabled:false}],'2026-12-20'),null);
// unpriced room
assert.match(R.validateBooking({...villa,rooms:[{id:'a',price:{}}]},[],{type:'rooms',rooms:['a']},'2026-12-01','2026-12-02'),/not set/);
console.log('booking-rules: all tests passed');
