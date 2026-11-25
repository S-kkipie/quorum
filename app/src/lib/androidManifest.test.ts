import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The shell keeps the hub URL and the device token in app storage; Android backups (cloud or adb)
// must not copy them off the phone.
describe('Android manifest', () => {
  it('turns app backups off', () => {
    const xml = readFileSync(resolve(import.meta.dirname, '../../../android-app/android/app/src/main/AndroidManifest.xml'), 'utf8')
    expect(xml).toContain('android:allowBackup="false"')
    expect(xml).not.toContain('android:allowBackup="true"')
  })
})
