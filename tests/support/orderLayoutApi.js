let count=16
export function setFixtureCount(value){count=value}
export async function openOrdersRequest(broker,{input,signal}={}){
  if(input)throw Error('레이아웃 검증에서는 주문 변경을 전송하지 않습니다.')
  signal?.throwIfAborted()
  return {status:'success',broker,selectedAccountRef:'a'.repeat(32),accountScope:'b'.repeat(64),accountLabel:'모의 계좌 1',asOf:'2026-11-13',fetchedAt:new Date().toISOString(),managementReady:true,
    accounts:[{id:'a'.repeat(32),label:'모의 계좌 1'},{id:'c'.repeat(32),label:'모의 계좌 2'}],items:Array.from({length:count},(_,i)=>({id:String(i),scope:'d'.repeat(64),version:'e'.repeat(64),accountRef:'a'.repeat(32),name:`모의 검증 종목 ${i+1}`,symbol:'005930',side:i%2?'sell':'buy',quantity:10,filledQuantity:i%2?2:0,remainingQuantity:i%2?8:10,orderPrice:70000,priceType:'limit',orderType:'지정가',orderedAt:null,orderNumber:String(i+100),exchange:'KRX',session:'정규장',status:'미체결',canAmend:true,canCancel:true}))}
}
export async function placeBrokerOrder(){throw Error('레이아웃 검증에서는 실제 주문을 전송하지 않습니다.')}
