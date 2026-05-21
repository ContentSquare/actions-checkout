import * as assert from 'assert'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as github from '@actions/github'
import * as io from '@actions/io'
import * as path from 'path'
import * as retryHelper from './retry-helper'
import * as toolCache from '@actions/tool-cache'
import {v4 as uuid} from 'uuid'
import {getServerApiUrl} from './url-helper'

const IS_WINDOWS = process.platform === 'win32'

export interface RepositoryObjectFormatResult {
  defaultBranch?: string
  format: string
  succeeded: boolean
}

export async function downloadRepository(
  authToken: string,
  owner: string,
  repo: string,
  ref: string,
  commit: string,
  repositoryPath: string,
  baseUrl?: string
): Promise<void> {
  // Determine the default branch
  if (!ref && !commit) {
    core.info('Determining the default branch')
    ref = await getDefaultBranch(authToken, owner, repo, baseUrl)
  }

  // Download the archive
  let archiveData = await retryHelper.execute(async () => {
    core.info('Downloading the archive')
    return await downloadArchive(authToken, owner, repo, ref, commit, baseUrl)
  })

  // Write archive to disk
  core.info('Writing archive to disk')
  const uniqueId = uuid()
  const archivePath = IS_WINDOWS
    ? path.join(repositoryPath, `${uniqueId}.zip`)
    : path.join(repositoryPath, `${uniqueId}.tar.gz`)
  await fs.promises.writeFile(archivePath, archiveData)
  archiveData = Buffer.from('') // Free memory

  // Extract archive
  core.info('Extracting the archive')
  const extractPath = path.join(repositoryPath, uniqueId)
  await io.mkdirP(extractPath)
  if (IS_WINDOWS) {
    await toolCache.extractZip(archivePath, extractPath)
  } else {
    await toolCache.extractTar(archivePath, extractPath)
  }
  await io.rmRF(archivePath)

  // Determine the path of the repository content. The archive contains
  // a top-level folder and the repository content is inside.
  const archiveFileNames = await fs.promises.readdir(extractPath)
  assert.ok(
    archiveFileNames.length == 1,
    'Expected exactly one directory inside archive'
  )
  const archiveVersion = archiveFileNames[0] // The top-level folder name includes the short SHA
  core.info(`Resolved version ${archiveVersion}`)
  const tempRepositoryPath = path.join(extractPath, archiveVersion)

  // Move the files
  for (const fileName of await fs.promises.readdir(tempRepositoryPath)) {
    const sourcePath = path.join(tempRepositoryPath, fileName)
    const targetPath = path.join(repositoryPath, fileName)
    if (IS_WINDOWS) {
      await io.cp(sourcePath, targetPath, {recursive: true}) // Copy on Windows (Windows Defender may have a lock)
    } else {
      await io.mv(sourcePath, targetPath)
    }
  }
  await io.rmRF(extractPath)
}

/**
 * Looks up the default branch name
 */
export async function getDefaultBranch(
  authToken: string,
  owner: string,
  repo: string,
  baseUrl?: string
): Promise<string> {
  return await retryHelper.execute(async () => {
    core.info('Retrieving the default branch name')
    const octokit = github.getOctokit(authToken, {
      baseUrl: getServerApiUrl(baseUrl)
    })
    let result: string
    try {
      // Get the default branch from the repo info
      const response = await octokit.rest.repos.get({owner, repo})
      result = response.data.default_branch
      assert.ok(result, 'default_branch cannot be empty')
    } catch (err) {
      // Handle .wiki repo
      if (
        (err as any)?.status === 404 &&
        repo.toUpperCase().endsWith('.WIKI')
      ) {
        result = 'master'
      }
      // Otherwise error
      else {
        throw err
      }
    }

    // Print the default branch
    core.info(`Default branch '${result}'`)

    // Prefix with 'refs/heads'
    if (!result.startsWith('refs/')) {
      result = `refs/heads/${result}`
    }

    return result
  })
}

export async function tryGetRepositoryObjectFormat(
  authToken: string,
  owner: string,
  repo: string,
  baseUrl?: string,
  ref?: string,
  commit?: string
): Promise<RepositoryObjectFormatResult> {
  try {
    const commitFormat = getObjectFormat(commit)
    if (commitFormat) {
      return {format: commitFormat, succeeded: true}
    }

    const octokit = github.getOctokit(authToken, {
      baseUrl: getServerApiUrl(baseUrl)
    })

    let branchName = getBranchName(ref)
    let defaultBranch = ''
    if (!branchName) {
      const repository = await octokit.rest.repos.get({owner, repo})
      defaultBranch = repository.data.default_branch
      assert.ok(defaultBranch, 'default_branch cannot be empty')
      branchName = defaultBranch
    }

    const branch = await octokit.rest.repos.getBranch({
      owner,
      repo,
      branch: branchName
    })
    const branchFormat = getObjectFormat(branch.data.commit.sha)
    if (branchFormat) {
      return {
        defaultBranch: defaultBranch || undefined,
        format: branchFormat,
        succeeded: true
      }
    }

    core.debug('Unable to determine repository object format from commit SHA')
    return {format: '', succeeded: false}
  } catch (err) {
    core.debug(
      `Unable to determine repository object format: ${(err as any)?.message ?? err}`
    )
    return {format: '', succeeded: false}
  }
}

function getBranchName(ref?: string): string {
  if (!ref) {
    return ''
  }

  const headsPrefix = 'refs/heads/'
  if (ref.startsWith(headsPrefix)) {
    return ref.substring(headsPrefix.length)
  }

  if (!ref.startsWith('refs/') && !getObjectFormat(ref)) {
    return ref
  }

  return ''
}

function getObjectFormat(sha?: string): string {
  if (/^[0-9a-fA-F]{64}$/.test(sha || '')) {
    return 'sha256'
  }
  if (/^[0-9a-fA-F]{40}$/.test(sha || '')) {
    return 'sha1'
  }
  return ''
}

async function downloadArchive(
  authToken: string,
  owner: string,
  repo: string,
  ref: string,
  commit: string,
  baseUrl?: string
): Promise<Buffer> {
  const octokit = github.getOctokit(authToken, {
    baseUrl: getServerApiUrl(baseUrl)
  })
  const download = IS_WINDOWS
    ? octokit.rest.repos.downloadZipballArchive
    : octokit.rest.repos.downloadTarballArchive
  const response = await download({
    owner: owner,
    repo: repo,
    ref: commit || ref
  })
  return Buffer.from(response.data as ArrayBuffer) // response.data is ArrayBuffer
}
