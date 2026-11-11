import {useEffect,useId,useRef,useState} from 'react'
import {Trash2} from 'lucide-react'
import AlertHelp from './AlertHelp'
import {advancedMetricFields,changeConditionMetric,comparableMetrics,conditionIssue,constant,defaultOperand,describeCondition,factorToPercent,isAdvancedMetric,isRawMetric,metric,metricNames,metricSpec,operators,percentToFactor,ratioComparison,screenIssues} from '../utils/screener'

export function ScreenNumberField({label,value,onChange,unit,min,max,step='any',increment=false}){
  const id=useId(),[raw,setRaw]=useState(value===null||value===undefined?'':String(value)),last=useRef(value)
  useEffect(()=>{if(!Object.is(value,last.current)){setRaw(value==null?'':String(value));last.current=value}},[value])
  const change=text=>{setRaw(text);const next=text===''?'':Number(text);last.current=next;onChange(next)}
  const bump=delta=>{const next=(Number.isFinite(value)?value:100)+delta;if(next>=min&&next<=max)change(String(next))}
  return <div className="screen-number-field"><label htmlFor={id}>{label}</label><div className="screen-number-control">
    <input id={id} aria-label={label} type="number" required min={min} max={max} step={step} value={raw} onChange={event=>change(event.target.value)}
      onKeyDown={event=>{if(increment&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();bump(event.key==='ArrowUp'?1:-1)}}}/>
    {unit&&<span className="screen-input-unit">{unit}</span>}
    {increment&&<><button type="button" aria-label={`${label} 1%p 줄이기`} disabled={!Number.isFinite(value)||value-1<min} onClick={()=>bump(-1)}>−</button><button type="button" aria-label={`${label} 1%p 늘리기`} disabled={!Number.isFinite(value)||value+1>max} onClick={()=>bump(1)}>+</button></>}
  </div></div>
}

function MetricHelp({name,label,help}){
  const spec=metricSpec(name)
  return <AlertHelp persistent symbol="!" label={`${label} 단위·비교 안내`} active={help.active} setActive={help.setActive} triggerClassName="screen-help-trigger" contentClassName="screen-help-tooltip">
    <strong>{spec.title} · {spec.unit}</strong><p>{spec.guide}</p>
    {!!spec.reference?.length&&<p>통상 참고 기준: {spec.reference.join(' · ')}. 참고 설정이며 매수·매도 추천이나 수익 보장이 아닙니다.</p>}
    <p>기간·평활 기간은 봉 수입니다. 현재 확정 일봉 검색에서는 거래일 기준입니다. 표준편차 배수·ATR 배수는 계산 매개변수이며 비교 기준 비율과 다릅니다.</p>
    <p>출처: 실험실 확정 일봉 DB. 국내주식 수집 가격은 원, 공급원의 Volume은 주 단위로 그대로 사용합니다. 조회 중인 확정 봉도 평균 계산에 포함됩니다.</p>
  </AlertHelp>
}

function MetricEditor({value,onChange,label,options,help}){
  const id=useId(),advanced=isAdvancedMetric(value.name),defaults=advanced?metric(value.name):null
  const names=options||Object.keys(metricNames),invalid=!names.includes(value.name)
  return <div className="screen-metric"><div className="screen-metric-heading"><label htmlFor={id}>{label}<small>{metricSpec(value.name).unit}</small></label><MetricHelp name={value.name} label={label} help={help}/></div>
    <select id={id} aria-label={label} value={value.name} onChange={event=>onChange(metric(event.target.value))}>
      {invalid&&<option value={value.name} disabled>{metricNames[value.name]} · 비교 조합 수정 필요</option>}{names.map(name=><option key={name} value={name}>{metricNames[name]}</option>)}
    </select>
    <div className="screen-params">{advanced?advancedMetricFields.filter(([key])=>defaults[key]!==null).map(([key,title,choices])=>choices?
      <label key={key}>{title}<select aria-label={`${label} ${title}`} value={value[key]??defaults[key]} onChange={event=>onChange({...value,[key]:event.target.value})}>{Object.entries(choices).map(([id,text])=><option key={id} value={id}>{text}</option>)}</select></label>:
      <ScreenNumberField key={key} label={`${label} ${title}`} value={value[key]??defaults[key]} unit={key==='atr_multiplier'?'배':'봉'} min={key==='atr_multiplier' ? .1 : 1} max={key==='atr_multiplier'?20:500} step={key==='atr_multiplier' ? .1 : 1} onChange={next=>onChange({...value,[key]:next})}/>):!isRawMetric(value.name)&&<>
      <ScreenNumberField label={`${label} ${value.name.startsWith('macd')?'단기 기간':'기간'}`} value={value.period} unit="봉" min={1} max={500} step={1} onChange={period=>onChange({...value,period})}/>
      {value.name.startsWith('macd')&&<><ScreenNumberField label={`${label} 장기`} value={value.slow} unit="봉" min={2} max={500} step={1} onChange={slow=>onChange({...value,slow})}/><ScreenNumberField label={`${label} 시그널 기간`} value={value.signal} unit="봉" min={1} max={100} step={1} onChange={signal=>onChange({...value,signal})}/></>}
      {value.name.startsWith('bb_')&&<ScreenNumberField label={`${label} 표준편차 배수`} value={value.multiplier} unit="배" min={.1} max={10} step={.1} onChange={multiplier=>onChange({...value,multiplier})}/>}
    </>}</div>
  </div>
}

export default function ScreenerCondition({value:c,index,onChange,onRemove,canRemove,help}){
  const touched=useRef(false),operatorTouched=useRef(false),[notice,setNotice]=useState(''),spec=metricSpec(c.left.name),r=c.right
  const ratio=r.kind==='metric'&&ratioComparison(c.left.name,r.metric.name),issue=conditionIssue(c)
  const label=`조건 ${index+1}`
  function changeLeft(left){
    const next=changeConditionMetric(c,left,{preserveConstant:touched.current,preserveOperator:operatorTouched.current})
    setNotice(JSON.stringify(next.right)!==JSON.stringify(c.right)?'선택 지표에 맞춰 비교 대상·기준값을 조정했습니다.':'')
    if(left.name!==c.left.name&&next.right!==c.right)touched.current=false
    onChange(next)
  }
  return <fieldset className="screen-condition"><legend>{label}</legend><button type="button" className="screen-remove" disabled={!canRemove} aria-label={`${label} 삭제`} onClick={onRemove}><Trash2 size={14}/></button>
    <MetricEditor value={c.left} label={`${label} 지표`} onChange={changeLeft} help={help}/>
    <label className="screen-field-label">비교<select aria-label={`${label} 비교`} value={c.operator} onChange={event=>{operatorTouched.current=true;onChange({...c,operator:event.target.value})}}>
      {Object.entries(operators).filter(([op])=>spec.states?op==='eq'||op===c.operator:op!=='eq').map(([op,title])=><option key={op} value={op}>{spec.states&&op!=='eq'?'기존 상태 코드 비교 · ':''}{title}</option>)}
    </select></label>
    {spec.states?<label className="screen-field-label">기준 상태<select aria-label={`${label} 기준 상태`} value={r.value??''} onChange={event=>onChange({...c,right:constant(Number(event.target.value))})}>
      {(!Object.hasOwn(spec.states,r.value)||r.kind!=='constant')&&<option value={r.value??''} disabled>기존 상태 조건 수정 필요</option>}{Object.entries(spec.states).map(([value,text])=><option value={value} key={value}>{text}</option>)}
    </select></label>:<>
      <div className="screen-operand-toggle">{[['constant','숫자와 비교'],['metric','지표와 비교']].map(([kind,text])=><button type="button" key={kind} aria-pressed={r.kind===kind} onClick={()=>{if(r.kind===kind)return;touched.current=false;onChange({...c,right:defaultOperand(c.left.name,kind)})}}>{text}</button>)}</div>
      {r.kind==='constant'?<ScreenNumberField label={`${label} 기준값`} value={r.value} unit={spec.unit} min={spec.min} max={spec.max} onChange={value=>{touched.current=true;onChange({...c,right:constant(value)})}}/>:<>
        <MetricEditor value={r.metric} label={`${label} 비교 지표`} options={comparableMetrics(c.left.name)} onChange={metric=>onChange({...c,right:{...r,metric}})} help={help}/>
        {ratio?<><ScreenNumberField label={`${label} 비교 기준 비율`} value={factorToPercent(r.factor)} unit="%" min={1} max={100000} increment onChange={value=>onChange({...c,right:{...r,factor:percentToFactor(value)}})}/>
          <p className="screen-input-note">100% = 같은 값 · 120% = 20% 높음 · 200% = 두 배. 버튼·↑↓는 1%p씩, 소수 비율은 직접 입력합니다.</p></>:<details className="screen-advanced-factor" open={r.factor!==1||undefined}><summary>고급 배수 비교{r.factor!==1?' · 기존 계산 유지':''}</summary>
          <ScreenNumberField label={`${label} 고급 배수`} value={r.factor} unit="배" min={.01} max={1000} onChange={factor=>onChange({...c,right:{...r,factor}})}/><p className="screen-input-note">기준 지표 원값에 곱합니다. 수익률·증가율이 아니며 음수 기준에도 그대로 곱합니다. 일반 지표 비교는 1배입니다.</p>
        </details>}
      </>}
    </>}
    {spec.max===100&&<p className="screen-input-note">기준값 범위 0~100 · 주가 수익률이 아닌 지수값</p>}
    {spec.states&&c.operator!=='eq'&&<p className="screen-input-note">기존 상태 코드의 크기·교차 판정을 보존합니다. ‘상태 일치’로 바꾸기 전까지 정확한 상태 선택과 다를 수 있습니다.</p>}
    {notice&&<p className="screen-input-note" role="status">{notice}</p>}
    {issue&&<p className="screen-condition-error" role="alert">{screenIssues[issue]} 기존 조건은 자동 변환하지 않습니다.</p>}
    <p className="screen-condition-preview" aria-live="polite">{describeCondition(c)}</p>
  </fieldset>
}
