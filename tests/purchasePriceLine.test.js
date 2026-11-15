import test from 'node:test'
import assert from 'node:assert/strict'
import {createPurchasePriceLine,purchasePriceLabel} from '../src/utils/purchasePriceLine.js'

function fixture() {
  const created=[],removed=[],ranges=[]
  let visible={from:180000,to:190000},autoScale=true
  const scale={getVisibleRange:()=>visible,setVisibleRange:range=>{visible=range;autoScale=false;ranges.push(range)},options:()=>({autoScale}),applyOptions:options=>{autoScale=options.autoScale;if(autoScale)visible={from:180000,to:190000}}}
  const series={
    createPriceLine(options){const line={options,applyOptions(next){line.options={...line.options,...next}}};created.push(line);return line},
    removePriceLine(line){removed.push(line)},
    priceScale(){return scale},
  }
  return {created,removed,ranges,scale,controller:createPurchasePriceLine(series,{background:'#0c1a2b'}),visible:()=>visible}
}

test('native average line updates in place, accepts only positive numeric values, and cleans up once',()=>{
  const h=fixture()
  for(const value of [null,0,-1,NaN,Infinity,'200000'])h.controller.setPrice(value)
  assert.equal(h.created.length,0)
  h.controller.setPrice(200000)
  assert.equal(h.created[0].options.price,200000)
  assert.equal(h.created[0].options.title,'내 평균 매입가 200,000원')
  assert.equal(h.created[0].options.lineStyle,2)
  h.controller.setPrice(201234.56)
  assert.equal(h.created.length,1)
  assert.equal(h.created[0].options.price,201234.56)
  assert.equal(h.ranges.length,0)
  h.controller.setPrice(null);h.controller.setPrice(null)
  assert.equal(h.removed.length,1)
  h.controller.setPrice(200000)
  assert.equal(h.created.length,2)
  h.controller.dispose();h.controller.dispose();h.controller.setPrice(210000)
  assert.equal(h.created.length,2)
  assert.equal(h.removed.length,2)
})

test('theme changes preserve the price and line identity without changing viewport',()=>{
  const h=fixture();h.controller.setPrice(200000)
  const line=h.created[0],dark=line.options.color
  h.controller.setPalette({background:'#ffffff'})
  assert.notEqual(line.options.color,dark)
  assert.equal(line.options.axisLabelTextColor,'#ffffff')
  assert.equal(line.options.price,200000)
  assert.equal(h.created.length,1);assert.equal(h.removed.length,0);assert.equal(h.ranges.length,0)
})

test('only explicit reveal expands the native price scale and never fabricates candle data',()=>{
  const h=fixture();h.controller.setPrice(200000)
  assert.equal(h.ranges.length,0)
  assert.equal(h.controller.reveal(),true)
  assert.ok(h.visible().from<180000&&h.visible().to>200000)
  assert.equal(h.controller.reveal(),true);assert.equal(h.ranges.length,1)
  h.controller.setPrice(null)
  assert.equal(h.controller.reveal(),false);assert.equal(h.ranges.length,1)
  assert.equal(h.scale.options().autoScale,true)
  assert.deepEqual(h.visible(),{from:180000,to:190000})
  assert.equal(purchasePriceLabel(200000.125),'내 평균 매입가 200,000.125원')
})

test('turning off restores the previous manual scale unless the user has since changed it',()=>{
  const h=fixture(),original={from:170000,to:195000}
  h.scale.setVisibleRange(original)
  h.controller.setPrice(800000);h.controller.reveal();h.controller.setPrice(null)
  assert.deepEqual(h.visible(),original)
  h.controller.setPrice(800000);h.controller.reveal()
  const manual={from:100000,to:900000};h.scale.setVisibleRange(manual)
  h.controller.setPrice(null)
  assert.deepEqual(h.visible(),manual)
})
