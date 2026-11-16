import test from 'node:test'
import assert from 'node:assert/strict'
import {createTradingWorkerHealth} from './tradingWorkerHealth.js'
test('worker readiness requires a healthy authenticated tick, expires and cannot mask failed work',()=>{
 let time=1000;const health=createTradingWorkerHealth({now:()=>time,ttlMs:200})
 assert.equal(health.ready(),false);health.seen();assert.equal(health.ready(),false)
 health.settled(true);assert.equal(health.ready(),true)
 time+=200;assert.equal(health.ready(),false)
 health.seen();health.settled(false);assert.equal(health.ready(),false)
 health.seen();health.settled(true);assert.equal(health.ready(),true)
 time-=1;assert.equal(health.ready(),false)
})
