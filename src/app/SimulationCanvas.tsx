import { useEffect, useRef } from 'react'
import type { MouseEvent } from 'react'
import type { GameState } from '../sim'
import { unitWorldPos } from '../sim'
import type { Camera } from '../render'
import { drawFrame, fitCamera, worldToScreen } from '../render'

const CANVAS_WIDTH = 960
const CANVAS_HEIGHT = 720
const CLICK_HIT_RADIUS = 20

interface Props {
  getState: () => GameState
  tick: number
  /** Bumped on every reset()/startReplay(), so a new map redraws even if `tick` stays at 0. */
  episode: number
  selectedUnitId: number | null
  onSelectUnit: (id: number | null) => void
  showVision: boolean
  showAttackRange: boolean
  showPatch: boolean
}

/**
 * §12: simの状態スナップショットを読んで1frame描画するだけ。ロジックは持たない。
 * `tick`はuseSimulationLoopがフレームごとに高々1回しか更新しないので、そのままeffectの
 * 再描画トリガーとして使う。`episode`はリセット時に`tick`が変化しないケースを拾うため。
 */
export function SimulationCanvas({
  getState,
  tick,
  episode,
  selectedUnitId,
  onSelectUnit,
  showVision,
  showAttackRange,
  showPatch,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cameraRef = useRef<Camera | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const state = getState()
    const camera = fitCamera(state, canvas.width, canvas.height)
    cameraRef.current = camera
    drawFrame(ctx, state, camera, { showVision, showAttackRange, showPatch, selectedUnitId })
  }, [getState, tick, episode, selectedUnitId, showVision, showAttackRange, showPatch])

  const handleClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const camera = cameraRef.current
    if (!canvas || !camera) return

    const rect = canvas.getBoundingClientRect()
    const clickX = ((e.clientX - rect.left) / rect.width) * canvas.width
    const clickY = ((e.clientY - rect.top) / rect.height) * canvas.height

    const state = getState()
    let closestId: number | null = null
    let closestDist = CLICK_HIT_RADIUS
    for (const unit of state.units) {
      if (!unit.alive) continue
      const screen = worldToScreen(camera, unitWorldPos(state, unit))
      const dist = Math.hypot(screen.x - clickX, screen.y - clickY)
      if (dist < closestDist) {
        closestDist = dist
        closestId = unit.id
      }
    }
    onSelectUnit(closestId)
  }

  return (
    <div className="map-pane">
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        onClick={handleClick}
        style={{ background: 'var(--bg-panel)', borderRadius: 6 }}
      />
    </div>
  )
}
