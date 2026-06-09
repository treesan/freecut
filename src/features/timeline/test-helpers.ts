import type { AudioItem, TimelineTrack, VideoItem } from '@/types/timeline'
import { useItemsStore } from './stores/items-store'
import { useTimelineSettingsStore } from './stores/timeline-settings-store'

type TimelineTrackOverrides = Partial<TimelineTrack> & Pick<TimelineTrack, 'id' | 'name' | 'order'>

export function makeTimelineTrack(overrides: TimelineTrackOverrides): TimelineTrack {
  return {
    height: 80,
    locked: false,
    visible: true,
    muted: false,
    solo: false,
    volume: 0,
    items: [],
    ...overrides,
  }
}

export function makeTimelineVideoItem(overrides: Partial<VideoItem> = {}): VideoItem {
  return {
    id: 'video-1',
    type: 'video',
    trackId: 'track-v1',
    from: 0,
    durationInFrames: 60,
    label: 'clip.mp4',
    src: 'blob:video',
    mediaId: 'media-1',
    sourceStart: 0,
    sourceEnd: 60,
    sourceDuration: 120,
    sourceFps: 30,
    ...overrides,
  }
}

export function makeTimelineAudioItem(overrides: Partial<AudioItem> = {}): AudioItem {
  return {
    id: 'audio-1',
    type: 'audio',
    trackId: 'track-a1',
    from: 0,
    durationInFrames: 60,
    label: 'clip.wav',
    src: 'blob:audio',
    mediaId: 'media-1',
    sourceStart: 0,
    sourceEnd: 60,
    sourceDuration: 120,
    sourceFps: 30,
    ...overrides,
  }
}

export function setDefaultRootTimelineTracks() {
  useItemsStore
    .getState()
    .setTracks([
      makeTimelineTrack({ id: 'track-v1', name: 'V1', kind: 'video', order: 0 }),
      makeTimelineTrack({ id: 'track-a1', name: 'A1', kind: 'audio', order: 1 }),
    ])
}

export function resetTimelineItemsTestState() {
  useTimelineSettingsStore.setState({ fps: 30 })
  useItemsStore.getState().setItems([])
  useItemsStore.getState().setTracks([])
}
