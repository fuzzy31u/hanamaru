import http from 'node:http'
import { URL } from 'node:url'
import { google } from 'googleapis'

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET
const PORT = 4000
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`
const SCOPE = ['https://www.googleapis.com/auth/calendar.events']

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.')
  process.exit(1)
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPE,
})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  if (url.pathname !== '/oauth/callback') {
    res.writeHead(404)
    res.end()
    return
  }
  const code = url.searchParams.get('code')
  if (!code) {
    res.writeHead(400)
    res.end('No code in callback')
    return
  }
  const { tokens } = await oauth2.getToken(code)
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('OK. You can close this tab.')
  console.log('\n--- Refresh token (store in Secret Manager) ---')
  console.log(tokens.refresh_token)
  console.log('-----------------------------------------------\n')
  server.close()
})

server.listen(PORT, () => {
  console.log('Open this URL in your browser to authorize:')
  console.log(authUrl)
})
