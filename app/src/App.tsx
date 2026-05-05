import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import styled, { createGlobalStyle } from "styled-components";
import { find } from "lodash";
import CommitGraph from "./components/CommitGraph";
import WordCloud from "./components/WordCloud";
import FileClusterMap from "./components/FileClusterMap";
import CommitTimeline from "./components/CommitTimeline";
import StreamGraph from "./components/StreamGraph";
import TestViz from "./components/TestViz";
import type { Commit, CommitFile } from "./types/git";

const GlobalStyle = createGlobalStyle`
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0d1117; color: #c9d1d9;
    font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', monospace;
    font-size: 13px;
  }
`;

const REPOS = [
  {
    key: "flask",
    label: "Flask",
    mainBranch: "main",
    description:
      "A lightweight WSGI web framework for Python. Built for simplicity and extensibility — Flask lets you build web apps with minimal boilerplate.",
  },
  {
    key: "click",
    label: "Click",
    mainBranch: "main",
    description:
      "A Python package for creating beautiful command-line interfaces with as little code as necessary. Composable, arbitrary nesting of commands.",
  },
  {
    key: "requests",
    label: "Requests",
    mainBranch: "main",
    description:
      "HTTP for Humans. The most downloaded Python package — a simple, elegant HTTP library that abstracts away the complexity of making HTTP requests.",
  },
  {
    key: "httpx",
    label: "HTTPX",
    mainBranch: "master",
    description:
      "A next-generation HTTP client for Python with async support, HTTP/2, and modern features. The successor to Requests for async workflows.",
  },
];

const VIZS = [
  {
    key: "wordcloud",
    label: "Word Cloud",
    description:
      "Drag to select a range of commits in the graph — the word cloud updates to show the most frequent words in those commit messages. Click a commit dot to filter by branch.",
  },
  {
    key: "clustermap",
    label: "File Cluster Map",
    description:
      "Force-directed graph of the top 60 files. Files modified together in the same commit are pulled toward each other — the more often they co-change, the stronger the attraction. Node size = total commits touched. Color = directory. Drag nodes, scroll to zoom.",
  },
  {
    key: "streamgraph",
    label: "Sediment Graph",
    description:
      "Stream graph showing how much code from each era survives over time. Each band is a cohort (1/64th of the repo's history). Band width = net lines of code. Each file is charged to the cohort that introduced it — edits and deletions reduce that cohort. Cool colors = old code, warm colors = new code.",
  },
  {
    key: "test",
    label: "Test",
    description: "A placeholder for a future visualization.",
  },
];

// ── Styled components ─────────────────────────────────────────────────────────
const AppWrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
`;

const Header = styled.header`
  padding: 0 32px;
  border-bottom: 1px solid #21262d;
  display: flex;
  align-items: stretch;
  background: #010409;
  flex-shrink: 0;
`;

const AppTitle = styled.div`
  font-size: 15px;
  font-weight: 600;
  color: #f0f6fc;
  display: flex;
  align-items: center;
`;

const PageLabel = styled.div`
  display: flex;
  align-items: center;
  font-size: 13px;
  color: #58a6ff;
  border-bottom: 2px solid #58a6ff;
  padding: 0 4px;
  margin-left: 24px;
`;

const RepoBtn = styled.button<{ $active: boolean }>`
  background: ${({ $active }) => ($active ? "#21262d" : "transparent")};
  color: ${({ $active }) => ($active ? "#f0f6fc" : "#8b949e")};
  border: 1px solid ${({ $active }) => ($active ? "#30363d" : "transparent")};
  border-radius: 6px;
  padding: 4px 12px;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  &:hover {
    color: #f0f6fc;
    border-color: #30363d;
    background: #21262d;
  }
`;

const SubHeader = styled.div`
  padding: 12px 32px;
  border-bottom: 1px solid #21262d;
  display: flex;
  align-items: flex-start;
  gap: 32px;
  flex-shrink: 0;
  flex-wrap: wrap;
`;

const DescBlock = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 260px;
`;

const SelectorRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`;

const SelectorLabel = styled.span`
  font-size: 10px;
  color: #6e7681;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
`;

const SegBtn = styled.button<{ $active: boolean }>`
  background: ${({ $active }) => ($active ? "#21262d" : "transparent")};
  color: ${({ $active }) => ($active ? "#f0f6fc" : "#8b949e")};
  border: 1px solid ${({ $active }) => ($active ? "#30363d" : "transparent")};
  border-radius: 6px;
  padding: 3px 10px;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  &:hover {
    color: #f0f6fc;
    border-color: #30363d;
    background: #21262d;
  }
`;

const PageDesc = styled.p`
  font-size: 12px;
  color: #8b949e;
  line-height: 1.5;
  max-width: 500px;
`;

const RepoGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-left: auto;
  align-items: flex-end;
`;

const RepoButtons = styled.div`
  display: flex;
  gap: 6px;
`;

const RepoDesc = styled.p`
  font-size: 11px;
  color: #6e7681;
  line-height: 1.4;
  max-width: 320px;
  text-align: right;
`;

const Body = styled.div`
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  overflow: hidden;
  min-height: 0;
`;

const TimelineStrip = styled.div`
  height: 72px;
  flex-shrink: 0;
  border-top: 1px solid #21262d;
  background: #0d1117;
  display: flex;
  flex-direction: column;
`;

const TimelineLabel = styled.div`
  padding: 3px 16px;
  font-size: 10px;
  color: #6e7681;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  flex-shrink: 0;
`;

const TimelineContent = styled.div`
  flex: 1;
  min-height: 0;
`;

const Pane = styled.div`
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid #21262d;
  &:last-child {
    border-right: none;
  }
`;

const PaneLabel = styled.div`
  padding: 5px 12px;
  font-size: 10px;
  color: #6e7681;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border-bottom: 1px solid #161b22;
  background: #010409;
  flex-shrink: 0;
`;

const PaneContent = styled.div`
  flex: 1;
  overflow: hidden;
  min-height: 0;
`;

const Status = styled.p<{ $error?: boolean }>`
  padding: 32px;
  color: ${({ $error }) => ($error ? "#f78166" : "#8b949e")};
`;

async function fetchCommits(repoKey: string): Promise<Commit[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}${repoKey}_commits.json`);
  if (!res.ok) throw new Error(`Failed to fetch commits for ${repoKey}`);

  // JSON contains parent/children hashes as strings, we need to convert to Commit references
  interface CommitRaw {
    hash: string;
    parents: string[];
    children: string[];
    author: string;
    date: string;
    subject: string;
    branch: string | null;
    merge?: string | null;
    files?: CommitFile[];
  }

  const rawCommits: CommitRaw[] = await res.json();
  const commitMap = new Map<string, Commit>();

  // First pass: create all commit objects with empty parents/children arrays
  for (const raw of rawCommits) {
    const commit: Commit = {
      hash: raw.hash,
      parents: [],
      children: [],
      author: raw.author,
      date: raw.date,
      subject: raw.subject,
      branch: raw.branch,
      merge: raw.merge,
      files: raw.files,
    };
    commitMap.set(raw.hash, commit);
  }

  // Second pass: populate parent and children references
  for (const raw of rawCommits) {
    const commit = commitMap.get(raw.hash)!;
    commit.parents = raw.parents
      .map((hash) => commitMap.get(hash))
      .filter((p): p is Commit => p !== undefined);
    commit.children = raw.children
      .map((hash) => commitMap.get(hash))
      .filter((c): c is Commit => c !== undefined);
  }

  return Array.from(commitMap.values());
}

export default function App() {
  const [activeRepo, setActiveRepo] = useState(REPOS[0].key);
  const [activeViz, setActiveViz] = useState(VIZS[0].key);
  const [selectedCommits, setSelectedCommits] = useState<Commit[]>([]);
  const [timeFilteredCommits, setTimeFilteredCommits] = useState<Commit[] | null>(null);
  const [timeRange, setTimeRange] = useState<[Date, Date] | null>(null);

  const { data, isLoading, isError, error } = useQuery<Commit[]>({
    queryKey: ["commits", activeRepo],
    queryFn: () => fetchCommits(activeRepo),
    gcTime: 0, // discard previous repo's data from cache immediately on switch
  });

  const repoConfig = find(REPOS, { key: activeRepo })!;
  const vizConfig = find(VIZS, { key: activeViz })!;

  const graphCommits =
    activeViz === "clustermap" ? (timeFilteredCommits ?? data ?? []) : (data ?? []);
  const cloudCommits = selectedCommits.length > 0 ? selectedCommits : (data ?? []);
  const clusterCommits = timeFilteredCommits ?? cloudCommits;

  const handleRepoChange = (key: string) => {
    setActiveRepo(key);
    setSelectedCommits([]);
    setTimeFilteredCommits(null);
    setTimeRange(null);
  };

  const handleVizChange = (key: string) => {
    setActiveViz(key);
    if (key !== "clustermap") {
      setTimeFilteredCommits(null);
      setTimeRange(null);
      setSelectedCommits([]);
    }
  };

  const handleTimelineChange = useCallback((filtered: Commit[], range: [Date, Date] | null) => {
    setTimeFilteredCommits(range ? filtered : null);
    setTimeRange(range);
    setSelectedCommits([]);
  }, []);

  return (
    <>
      <GlobalStyle />
      <AppWrapper>
        <Header>
          <AppTitle>Git Explorer</AppTitle>
          <PageLabel>{vizConfig.label}</PageLabel>
        </Header>

        <SubHeader>
          <DescBlock>
            <SelectorRow>
              <SelectorLabel>Visualization</SelectorLabel>
              {VIZS.map((v) => (
                <SegBtn
                  key={v.key}
                  $active={activeViz === v.key}
                  onClick={() => handleVizChange(v.key)}
                >
                  {v.label}
                </SegBtn>
              ))}
            </SelectorRow>
            <PageDesc>{vizConfig.description}</PageDesc>
          </DescBlock>

          <RepoGroup>
            <SelectorRow>
              <SelectorLabel>Repo</SelectorLabel>
              <RepoButtons>
                {REPOS.map((r) => (
                  <RepoBtn
                    key={r.key}
                    $active={activeRepo === r.key}
                    onClick={() => handleRepoChange(r.key)}
                  >
                    {r.label}
                  </RepoBtn>
                ))}
              </RepoButtons>
            </SelectorRow>
            <RepoDesc>{repoConfig.description}</RepoDesc>
          </RepoGroup>
        </SubHeader>

        <Body>
          <Pane>
            <PaneLabel>Commit Graph</PaneLabel>
            <PaneContent>
              {isLoading && <Status>Loading commits…</Status>}
              {isError && <Status $error>Error: {(error as Error).message}</Status>}
              {data && (
                <CommitGraph
                  commits={graphCommits}
                  mainBranch={repoConfig.mainBranch}
                  onSelectionChange={setSelectedCommits}
                  skipBranchFilter={!!timeRange}
                />
              )}
            </PaneContent>
          </Pane>

          <Pane>
            <PaneLabel>
              {vizConfig.label}
              {activeViz === "clustermap"
                ? timeRange
                  ? ` · ${clusterCommits.length} commits in range`
                  : selectedCommits.length > 0
                    ? ` · ${selectedCommits.length} selected commits`
                    : data
                      ? ` · all ${data.length} commits`
                      : ""
                : selectedCommits.length > 0
                  ? ` · ${selectedCommits.length} selected commits`
                  : data
                    ? ` · all ${data.length} commits`
                    : ""}
            </PaneLabel>
            <PaneContent>
              {activeViz === "wordcloud" && <WordCloud commits={cloudCommits} allCommits={data ?? []} />}
              {activeViz === "clustermap" && (
                <FileClusterMap
                  commits={clusterCommits}
                  allCommits={data ?? []}
                  repoKey={activeRepo}
                />
              )}
              {activeViz === "streamgraph" && data && <StreamGraph key={activeRepo} commits={data} />}
              {activeViz === "test" && <TestViz />}
            </PaneContent>
          </Pane>
        </Body>

        {activeViz === "clustermap" && (
          <TimelineStrip>
            <TimelineLabel>
              Timeline
              {timeRange
                ? ` · ${timeRange[0].toLocaleDateString(undefined, { year: "numeric", month: "short" })} – ${timeRange[1].toLocaleDateString(undefined, { year: "numeric", month: "short" })}`
                : " · drag to filter by date range"}
            </TimelineLabel>
            <TimelineContent>
              {data && <CommitTimeline commits={data} onRangeChange={handleTimelineChange} />}
            </TimelineContent>
          </TimelineStrip>
        )}
      </AppWrapper>
    </>
  );
}
