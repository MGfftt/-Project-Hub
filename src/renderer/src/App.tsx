import AppShell from '@renderer/components/AppShell'
import { useLang } from '@renderer/lib/i18n'

export default function App(): JSX.Element {
  const lang = useLang()

  /*
   * The language is a module-level value that `t()` reads, not a React context,
   * so a switch has to remount the shell for every string to be re-read. The
   * key is the whole mechanism: React throws the old subtree away and mounts a
   * fresh one that calls `t()` in the new language.
   */
  return <AppShell key={lang} />
}
