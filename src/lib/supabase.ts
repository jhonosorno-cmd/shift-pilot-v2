import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://lhloombzbbsnoebqtogm.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxobG9vbWJ6YmJzbm9lYnF0b2dtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4MTI1NjIsImV4cCI6MjEwMTM4ODU2Mn0.OPB8-SLm4HZyfJXY96qozUbpeD9VDhbP9RhC94_cZCg';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    flowType: 'implicit',
  },
});

export const EF_URL = `${SUPABASE_URL}/functions/v1`;