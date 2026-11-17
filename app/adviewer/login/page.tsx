import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import LoginClient from './LoginClient'

export const dynamic = 'force-dynamic'

export default async function AdviewerLoginPage() {
  // Adviewer shares the FTE Board's auth. If the visitor already has a session,
  // don't make them sign in again — route staff to the dashboard and client-portal
  // accounts to their projects (mirrors the gate in adviewer/dashboard + lookbook).
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) {
    const { data: client } = await supabase
      .from('adviewer_clients')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle()
    redirect(client ? '/adviewer/projects' : '/adviewer/dashboard')
  }
  return <LoginClient />
}
