import { describe, expect, test } from 'claude-code/testing'

import { resolveIcon } from '../hooks/icons'
import type { IconTheme } from '../hooks/icons'

const THEME: IconTheme = {
  file: '_file',
  fileNames: { 'package.json': '_f_npm', '.gitignore': '_f_git', license: '_f_license' },
  fileExtensions: { 'd.ts': '_f_typescriptdef', 'test.ts': '_f_testts', txt: '_f_text', gitignore: '_f_gitext' },
  languageIds: { typescript: '_f_typescript', markdown: '_f_markdown', json: '_f_json', dockerfile: '_f_docker', dotenv: '_f_dotenv' },
}

describe('resolveIcon', () => {
  test('an exact file name wins over its extension and language', () => {
    expect(resolveIcon(THEME, 'package.json')).toBe('_f_npm')
    expect(resolveIcon(THEME, 'Package.JSON')).toBe('_f_npm')
    expect(resolveIcon(THEME, 'LICENSE')).toBe('_f_license')
    expect(resolveIcon(THEME, '.gitignore')).toBe('_f_git')
  })

  test('the longest listed extension wins over a shorter one and the language', () => {
    expect(resolveIcon(THEME, 'pane.test.ts')).toBe('_f_testts')
    expect(resolveIcon(THEME, 'index.d.ts')).toBe('_f_typescriptdef')
    expect(resolveIcon(THEME, 'notes.txt')).toBe('_f_text')
  })

  test('a file the theme maps by language goes through its VS Code language id', () => {
    expect(resolveIcon(THEME, 'register.ts')).toBe('_f_typescript')
    expect(resolveIcon(THEME, 'README.md')).toBe('_f_markdown')
    expect(resolveIcon(THEME, 'settings.json')).toBe('_f_json')
    expect(resolveIcon(THEME, 'Dockerfile')).toBe('_f_docker')
    expect(resolveIcon(THEME, '.env.local')).toBe('_f_dotenv')
  })

  test('anything else gets the default file icon', () => {
    expect(resolveIcon(THEME, 'main.rs')).toBe('_file')
    expect(resolveIcon(THEME, 'archive.unknown')).toBe('_file')
    expect(resolveIcon(THEME, 'Makefile')).toBe('_file')
  })
})
