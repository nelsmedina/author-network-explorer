// Field Topology Visualizer
// Hierarchical approach: Concept Clusters → Keystone Papers → Full Network

class FieldTopologyVisualizer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.network = null;
    this.nodes = null;
    this.edges = null;
    this.currentWorks = [];
    this.conceptClusters = new Map(); // conceptId -> { papers, keystones }
    this.keystonePapers = [];
    this.allAuthors = new Map();
    this.viewMode = 'clusters'; // 'clusters' | 'papers' | 'authors'
    this.isStabilizing = false;
    this.init();
  }

  init() {
    if (!this.container) return;

    if (this.container.offsetWidth === 0 || this.container.offsetHeight === 0) {
      setTimeout(() => this.init(), 100);
      return;
    }

    this.nodes = new vis.DataSet();
    this.edges = new vis.DataSet();

    const options = {
      nodes: {
        shape: 'dot',
        scaling: { min: 10, max: 50, label: { enabled: true, min: 8, max: 16 } },
        font: { color: '#fff', size: 10 },
        borderWidth: 2
      },
      edges: {
        color: { color: '#333', highlight: '#4ecca3' },
        width: 1,
        smooth: { type: 'continuous', roundness: 0.2 }
      },
      physics: { enabled: false },
      interaction: {
        hover: true,
        tooltipDelay: 100,
        dragView: true,
        zoomView: true,
        dragNodes: true
      }
    };

    this.network = new vis.Network(this.container, { nodes: this.nodes, edges: this.edges }, options);

    this.network.on('stabilized', () => {
      if (this.isStabilizing) {
        this.isStabilizing = false;
        this.network.setOptions({ physics: { enabled: false } });
        this.network.fit({ animation: { duration: 400, easingFunction: 'easeOutQuad' } });
      }
    });

    this.network.on('click', (params) => {
      if (params.nodes.length > 0) {
        this.onNodeClick(params.nodes[0]);
      } else {
        // Clicked empty space — hide panel
        const panel = document.getElementById('fieldPaperDetailPanel');
        if (panel) panel.style.display = 'none';
      }
    });

    this.network.on('doubleClick', (params) => {
      if (params.nodes.length > 0) {
        this.onNodeDoubleClick(params.nodes[0]);
      }
    });

    this.addViewControls();
    this.showPlaceholder();
  }

  addViewControls() {
    if (this.container.querySelector('.field-view-controls')) return;

    const controls = document.createElement('div');
    controls.className = 'field-view-controls';
    controls.style.cssText = `
      position: absolute;
      top: 10px;
      left: 10px;
      display: flex;
      gap: 4px;
      z-index: 10;
    `;

    const modes = [
      { id: 'clusters', label: 'Concept Map' },
      { id: 'papers', label: 'Paper Network' },
      { id: 'authors', label: 'Authors' }
    ];

    modes.forEach(mode => {
      const btn = document.createElement('button');
      btn.className = `field-view-btn ${mode.id === this.viewMode ? 'active' : ''}`;
      btn.dataset.mode = mode.id;
      btn.textContent = mode.label;
      btn.style.cssText = `
        padding: 6px 12px;
        background: ${mode.id === this.viewMode ? '#4ecca3' : '#1a1a2e'};
        color: ${mode.id === this.viewMode ? '#1a1a2e' : '#888'};
        border: 1px solid ${mode.id === this.viewMode ? '#4ecca3' : '#333'};
        border-radius: 4px;
        font-size: 11px;
        cursor: pointer;
        transition: all 0.2s;
      `;

      btn.addEventListener('click', () => {
        this.setViewMode(mode.id);
        controls.querySelectorAll('.field-view-btn').forEach(b => {
          const isActive = b.dataset.mode === mode.id;
          b.style.background = isActive ? '#4ecca3' : '#1a1a2e';
          b.style.color = isActive ? '#1a1a2e' : '#888';
          b.style.borderColor = isActive ? '#4ecca3' : '#333';
        });
      });

      controls.appendChild(btn);
    });

    this.container.style.position = 'relative';
    this.container.appendChild(controls);
  }

  setViewMode(mode) {
    this.viewMode = mode;
    // Hide paper detail panel when switching views
    const panel = document.getElementById('fieldPaperDetailPanel');
    if (panel) panel.style.display = 'none';
    if (this.currentWorks.length > 0) {
      this.buildVisualization();
    }
  }

  showPlaceholder() {
    this.nodes.clear();
    this.edges.clear();
    this.nodes.add({
      id: 'placeholder',
      label: 'Search a field to explore',
      color: { background: '#333', border: '#444' },
      size: 20,
      font: { color: '#666' }
    });
  }

  // Main entry point - called from fullpage.js
  updateVisualization(works, metrics) {
    if (!works || works.length === 0) {
      this.showPlaceholder();
      return;
    }

    this.currentWorks = works;
    this.processData(works);
    this.buildVisualization();
  }

  // Process all data: extract concepts, find clusters, identify keystones
  processData(works) {
    this.conceptClusters.clear();
    this.allAuthors.clear();
    this.keystonePapers = [];

    // Extract concepts (level 1-2 are subfields)
    works.forEach(work => {
      const concepts = (work.concepts || []).filter(c => c.level >= 1 && c.level <= 2 && c.score > 0.3);

      concepts.forEach(concept => {
        if (!this.conceptClusters.has(concept.id)) {
          this.conceptClusters.set(concept.id, {
            id: concept.id,
            name: concept.display_name,
            level: concept.level,
            papers: [],
            totalCitations: 0,
            recentPapers: 0,
            avgYear: 0
          });
        }

        const cluster = this.conceptClusters.get(concept.id);
        cluster.papers.push(work);
        cluster.totalCitations += work.cited_by_count || 0;
        if (work.publication_year >= new Date().getFullYear() - 3) {
          cluster.recentPapers++;
        }
      });

      // Extract authors
      (work.authorships || []).forEach(authorship => {
        const author = authorship.author;
        if (!author?.id) return;

        if (!this.allAuthors.has(author.id)) {
          this.allAuthors.set(author.id, {
            id: author.id,
            name: author.display_name || 'Unknown',
            papers: [],
            totalCitations: 0,
            concepts: new Set(),
            coauthors: new Set(),
            institutions: new Set(),
            recentPapers: 0
          });
        }

        const authorData = this.allAuthors.get(author.id);
        authorData.papers.push(work);
        authorData.totalCitations += work.cited_by_count || 0;

        if (work.publication_year >= new Date().getFullYear() - 3) {
          authorData.recentPapers++;
        }

        // Track concepts for this author
        (work.concepts || []).filter(c => c.level >= 1 && c.score > 0.3).forEach(c => {
          authorData.concepts.add(c.id);
        });

        // Track coauthors
        (work.authorships || []).forEach(co => {
          if (co.author?.id && co.author.id !== author.id) {
            authorData.coauthors.add(co.author.id);
          }
        });

        // Track institutions
        (authorship.institutions || []).forEach(inst => {
          if (inst.id) authorData.institutions.add(inst.id);
        });
      });
    });

    // Calculate cluster stats
    this.conceptClusters.forEach(cluster => {
      if (cluster.papers.length > 0) {
        const years = cluster.papers.map(p => p.publication_year || 2020);
        cluster.avgYear = years.reduce((a, b) => a + b, 0) / years.length;
        cluster.avgCitations = cluster.totalCitations / cluster.papers.length;
      }
    });

    // Find keystone papers for top clusters
    this.findKeystonePapers();
  }

  findKeystonePapers() {
    // Get top clusters by paper count
    const topClusters = Array.from(this.conceptClusters.values())
      .sort((a, b) => b.papers.length - a.papers.length)
      .slice(0, 10);

    const keystoneSet = new Set();

    topClusters.forEach(cluster => {
      // Find keystone papers: high citations + many references (synthesizers)
      const clusterPapers = cluster.papers
        .map(p => ({
          ...p,
          keystoneScore: (p.cited_by_count || 0) * 0.6 +
                         (p.referenced_works?.length || 0) * 0.4
        }))
        .sort((a, b) => b.keystoneScore - a.keystoneScore);

      // Take top 3-5 from each cluster
      const keystones = clusterPapers.slice(0, Math.min(5, Math.ceil(clusterPapers.length * 0.1)));

      keystones.forEach(k => {
        if (!keystoneSet.has(k.id)) {
          keystoneSet.add(k.id);
          this.keystonePapers.push({
            ...k,
            clusterId: cluster.id,
            clusterName: cluster.name
          });
        }
      });
    });
  }

  buildVisualization() {
    switch (this.viewMode) {
      case 'clusters':
        this.buildClusterView();
        break;
      case 'papers':
        this.buildPaperNetworkView();
        break;
      case 'authors':
        this.buildAuthorView();
        break;
    }
  }

  // Level 1: Concept Cluster Map
  buildClusterView() {
    this.nodes.clear();
    this.edges.clear();

    const clusters = Array.from(this.conceptClusters.values())
      .filter(c => c.papers.length >= 3)
      .sort((a, b) => b.papers.length - a.papers.length)
      .slice(0, 30);

    if (clusters.length === 0) {
      this.showPlaceholder();
      return;
    }

    const maxPapers = clusters[0].papers.length;
    const angleStep = (2 * Math.PI) / clusters.length;
    const radius = 300;

    clusters.forEach((cluster, index) => {
      const size = 15 + (cluster.papers.length / maxPapers) * 40;
      const angle = index * angleStep;

      // Color by activity (recent papers ratio)
      const activityRatio = cluster.recentPapers / cluster.papers.length;
      const hue = 160 + activityRatio * 60; // Green (active) to cyan (less active)
      const saturation = 50 + activityRatio * 30;
      const lightness = 35 + (1 - activityRatio) * 20;

      // Highlight clusters with high activity but low avg citations (hidden gems!)
      const isHiddenGem = activityRatio > 0.4 && cluster.avgCitations < 20;

      this.nodes.add({
        id: cluster.id,
        label: this.truncate(cluster.name, 20),
        title: `${cluster.name}\n${cluster.papers.length} papers\n${cluster.recentPapers} recent (3yr)\nAvg citations: ${cluster.avgCitations.toFixed(1)}${isHiddenGem ? '\n*Potential hidden gem area!' : ''}`,
        size: size,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        color: {
          background: isHiddenGem ? '#f59e0b' : `hsl(${hue}, ${saturation}%, ${lightness}%)`,
          border: isHiddenGem ? '#d97706' : `hsl(${hue}, ${saturation}%, ${lightness - 10}%)`
        },
        borderWidth: isHiddenGem ? 3 : 2,
        font: { size: Math.max(9, 9 + size / 8) }
      });
    });

    // Connect clusters that share papers
    const clusterIds = new Set(clusters.map(c => c.id));
    const edgeSet = new Set();

    this.currentWorks.forEach(work => {
      const workConcepts = (work.concepts || [])
        .filter(c => clusterIds.has(c.id))
        .map(c => c.id);

      for (let i = 0; i < workConcepts.length; i++) {
        for (let j = i + 1; j < workConcepts.length; j++) {
          const key = [workConcepts[i], workConcepts[j]].sort().join('|');
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
          }
        }
      }
    });

    // Add edges with weight based on shared papers
    const edgeCounts = new Map();
    this.currentWorks.forEach(work => {
      const workConcepts = (work.concepts || [])
        .filter(c => clusterIds.has(c.id))
        .map(c => c.id);

      for (let i = 0; i < workConcepts.length; i++) {
        for (let j = i + 1; j < workConcepts.length; j++) {
          const key = [workConcepts[i], workConcepts[j]].sort().join('|');
          edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
        }
      }
    });

    edgeCounts.forEach((count, key) => {
      if (count >= 2) {
        const [from, to] = key.split('|');
        this.edges.add({
          from, to,
          width: Math.min(1 + count * 0.3, 6),
          color: { color: `rgba(78, 204, 163, ${Math.min(0.2 + count * 0.05, 0.7)})` },
          title: `${count} shared papers`
        });
      }
    });

    this.addLegend('clusters');
    this.runPhysicsAndFit();
  }

  // Level 2+3: Paper Network with Keystone Anchors
  buildPaperNetworkView() {
    this.nodes.clear();
    this.edges.clear();

    if (this.keystonePapers.length === 0) {
      this.showPlaceholder();
      return;
    }

    // Position keystones in inner ring
    const keystoneAngleStep = (2 * Math.PI) / this.keystonePapers.length;
    const keystoneRadius = 200;

    const keystoneIds = new Set(this.keystonePapers.map(k => k.id));

    this.keystonePapers.forEach((paper, index) => {
      const angle = index * keystoneAngleStep;
      const citations = paper.cited_by_count || 0;

      this.nodes.add({
        id: paper.id,
        label: this.truncate(paper.display_name, 18),
        title: `*KEYSTONE: ${paper.display_name}\n${paper.publication_year || 'N/A'}\n${citations} citations\nCluster: ${paper.clusterName}`,
        size: 20 + Math.min(citations / 50, 15),
        x: Math.cos(angle) * keystoneRadius,
        y: Math.sin(angle) * keystoneRadius,
        color: { background: '#f59e0b', border: '#d97706' },
        borderWidth: 3,
        font: { size: 10, color: '#fff' }
      });
    });

    // Add other papers, positioned by their relationship to keystones
    const otherPapers = this.currentWorks
      .filter(p => !keystoneIds.has(p.id))
      .slice(0, 150); // Limit for performance

    // Calculate each paper's "distance" to keystones based on shared references
    otherPapers.forEach((paper, index) => {
      const paperRefs = new Set(paper.referenced_works || []);

      // Find which keystones this paper is most related to
      let bestKeystoneIndex = 0;
      let bestOverlap = 0;

      this.keystonePapers.forEach((keystone, ki) => {
        const keystoneRefs = new Set(keystone.referenced_works || []);
        let overlap = 0;
        paperRefs.forEach(ref => {
          if (keystoneRefs.has(ref)) overlap++;
        });
        // Also check if paper cites keystone or vice versa
        if (paperRefs.has(keystone.id)) overlap += 5;
        if (keystoneRefs.has(paper.id)) overlap += 5;

        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestKeystoneIndex = ki;
        }
      });

      // Position based on closest keystone, with distance based on overlap
      const keystoneAngle = bestKeystoneIndex * keystoneAngleStep;
      const distance = bestOverlap > 0
        ? keystoneRadius + 80 + (1 / (bestOverlap + 1)) * 150
        : keystoneRadius + 250 + Math.random() * 100; // Far out if no connection

      // Add some angular spread
      const spreadAngle = keystoneAngle + (Math.random() - 0.5) * 0.8;

      const citations = paper.cited_by_count || 0;
      const year = paper.publication_year || 2020;
      const isRecent = year >= new Date().getFullYear() - 3;
      const isHiddenGem = isRecent && citations < 10 && bestOverlap > 0;

      this.nodes.add({
        id: paper.id,
        label: isHiddenGem ? '*' + this.truncate(paper.display_name, 15) : this.truncate(paper.display_name, 15),
        title: `${paper.display_name}\n${year}\n${citations} citations${isHiddenGem ? '\n*Hidden gem candidate!' : ''}`,
        size: 8 + Math.min(citations / 20, 12),
        x: Math.cos(spreadAngle) * distance,
        y: Math.sin(spreadAngle) * distance,
        color: {
          background: isHiddenGem ? '#8b5cf6' : `hsl(${160 + (year - 2015) * 3}, 50%, 45%)`,
          border: isHiddenGem ? '#7c3aed' : `hsl(${160 + (year - 2015) * 3}, 50%, 35%)`
        },
        borderWidth: isHiddenGem ? 2 : 1
      });

      // Add edge to closest keystone if there's overlap
      if (bestOverlap > 0) {
        this.edges.add({
          from: paper.id,
          to: this.keystonePapers[bestKeystoneIndex].id,
          color: { color: 'rgba(78, 204, 163, 0.2)' },
          width: Math.min(1 + bestOverlap * 0.3, 3)
        });
      }
    });

    // Connect keystones that share references
    for (let i = 0; i < this.keystonePapers.length; i++) {
      for (let j = i + 1; j < this.keystonePapers.length; j++) {
        const refs1 = new Set(this.keystonePapers[i].referenced_works || []);
        const refs2 = new Set(this.keystonePapers[j].referenced_works || []);
        let overlap = 0;
        refs1.forEach(ref => { if (refs2.has(ref)) overlap++; });

        if (overlap >= 3) {
          this.edges.add({
            from: this.keystonePapers[i].id,
            to: this.keystonePapers[j].id,
            color: { color: 'rgba(245, 158, 11, 0.5)' },
            width: Math.min(2 + overlap * 0.5, 6)
          });
        }
      }
    }

    this.addLegend('papers');
    this.runPhysicsAndFit();
  }

  // Author Network View with better metrics
  buildAuthorView() {
    this.nodes.clear();
    this.edges.clear();

    // Get all authors, calculate metrics
    const authors = Array.from(this.allAuthors.values()).map(author => {
      const avgCitations = author.papers.length > 0
        ? author.totalCitations / author.papers.length
        : 0;

      // Niche score: many concepts but few coauthors = exploring diverse areas independently
      const nicheScore = author.concepts.size / (author.coauthors.size + 1);

      // Activity score: recent papers
      const activityScore = author.recentPapers / Math.max(author.papers.length, 1);

      // Hidden gem score: active in niche areas, not super high citations
      const hiddenGemScore = nicheScore * activityScore * (avgCitations < 50 ? 1.5 : 0.5);

      return {
        ...author,
        avgCitations,
        nicheScore,
        activityScore,
        hiddenGemScore
      };
    });

    // Sort by paper count but show more authors
    const topAuthors = authors
      .sort((a, b) => b.papers.length - a.papers.length)
      .slice(0, 100);

    if (topAuthors.length === 0) {
      this.showPlaceholder();
      return;
    }

    const maxPapers = topAuthors[0].papers.length;
    const authorIdSet = new Set(topAuthors.map(a => a.id));

    // Position in expanding spiral for better use of space
    topAuthors.forEach((author, index) => {
      const angle = index * 0.5;
      const radius = 100 + index * 8;

      const size = 10 + (author.papers.length / maxPapers) * 25;
      const isHiddenGem = author.hiddenGemScore > 0.5 && author.recentPapers >= 2;

      // Color by activity (green = active, blue = less active)
      const hue = 160 + (1 - author.activityScore) * 60;

      this.nodes.add({
        id: author.id,
        label: this.truncate(author.name, 16),
        title: `${author.name}\n${author.papers.length} papers\n${author.totalCitations} total citations\n${author.recentPapers} recent papers\nNiche score: ${author.nicheScore.toFixed(2)}${isHiddenGem ? '\n*Hidden gem researcher!' : ''}`,
        size: size,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        color: {
          background: isHiddenGem ? '#8b5cf6' : `hsl(${hue}, 55%, 45%)`,
          border: isHiddenGem ? '#7c3aed' : `hsl(${hue}, 55%, 35%)`
        },
        borderWidth: isHiddenGem ? 3 : 2
      });
    });

    // Connect coauthors (limit edges for performance)
    const edgeSet = new Set();
    let edgeCount = 0;
    const maxEdges = 300;

    topAuthors.forEach(author => {
      if (edgeCount >= maxEdges) return;

      author.coauthors.forEach(coauthorId => {
        if (edgeCount >= maxEdges) return;
        if (!authorIdSet.has(coauthorId)) return;

        const key = [author.id, coauthorId].sort().join('|');
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edgeCount++;
          this.edges.add({
            from: author.id,
            to: coauthorId,
            color: { color: 'rgba(78, 204, 163, 0.25)' },
            width: 1
          });
        }
      });
    });

    this.addLegend('authors');
    this.runPhysicsAndFit();
  }

  addLegend(type) {
    // Remove existing legend
    const existing = this.container.querySelector('.field-legend');
    if (existing) existing.remove();

    const legend = document.createElement('div');
    legend.className = 'field-legend';
    legend.style.cssText = `
      position: absolute;
      bottom: 10px;
      left: 10px;
      background: rgba(26, 26, 46, 0.9);
      padding: 10px;
      border-radius: 6px;
      font-size: 10px;
      color: #888;
      z-index: 10;
      max-width: 200px;
    `;

    const legends = {
      clusters: `
        <div style="margin-bottom: 6px; color: #fff; font-weight: 500;">Concept Clusters</div>
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
          <span style="width: 12px; height: 12px; background: #f59e0b; border-radius: 50%;"></span>
          <span>Hidden gem area (active, low citations)</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
          <span style="width: 12px; height: 12px; background: hsl(180, 60%, 40%); border-radius: 50%;"></span>
          <span>Active cluster</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="width: 12px; height: 12px; background: hsl(160, 50%, 50%); border-radius: 50%;"></span>
          <span>Less active cluster</span>
        </div>
        <div style="margin-top: 8px; font-style: italic;">Double-click cluster to explore papers</div>
      `,
      papers: `
        <div style="margin-bottom: 6px; color: #fff; font-weight: 500;">Paper Network</div>
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
          <span style="width: 12px; height: 12px; background: #f59e0b; border-radius: 50%;"></span>
          <span>Keystone paper (anchor)</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
          <span style="width: 12px; height: 12px; background: #8b5cf6; border-radius: 50%;"></span>
          <span>Hidden gem candidate</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="width: 12px; height: 12px; background: hsl(175, 50%, 45%); border-radius: 50%;"></span>
          <span>Regular paper (color = year)</span>
        </div>
        <div style="margin-top: 8px; font-style: italic;">Papers far from keystones = potential discoveries</div>
      `,
      authors: `
        <div style="margin-bottom: 6px; color: #fff; font-weight: 500;">Author Network</div>
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
          <span style="width: 12px; height: 12px; background: #8b5cf6; border-radius: 50%;"></span>
          <span>Hidden gem researcher</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
          <span style="width: 12px; height: 12px; background: hsl(160, 55%, 45%); border-radius: 50%;"></span>
          <span>Active author</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="width: 12px; height: 12px; background: hsl(220, 55%, 45%); border-radius: 50%;"></span>
          <span>Less active author</span>
        </div>
        <div style="margin-top: 8px; font-style: italic;">Size = paper count, Lines = co-authorship</div>
      `
    };

    legend.innerHTML = legends[type] || '';
    this.container.appendChild(legend);
  }

  onNodeClick(nodeId) {
    // Only show paper details in paper network view
    if (this.viewMode !== 'papers') return;

    const panel = document.getElementById('fieldPaperDetailPanel');
    const content = document.getElementById('fieldPaperDetailContent');
    if (!panel || !content) return;

    // Find the paper in currentWorks or keystonePapers
    let paper = this.currentWorks.find(w => w.id === nodeId);
    if (!paper) paper = this.keystonePapers.find(w => w.id === nodeId);
    if (!paper) return;

    const title = paper.display_name || 'Untitled';
    const year = paper.publication_year || 'N/A';
    const citations = paper.cited_by_count || 0;
    const doi = paper.doi;
    const authors = (paper.authorships || [])
      .map(a => a.author?.display_name)
      .filter(Boolean)
      .slice(0, 8);
    const authorStr = authors.join(', ') + (paper.authorships?.length > 8 ? ' ...' : '');

    content.innerHTML = `
      <div class="paper-detail-title">
        <a href="${doi || '#'}" target="_blank">${title}</a>
      </div>
      <div class="paper-detail-meta">
        ${year} · ${citations} citations
      </div>
      <div class="paper-detail-authors">${authorStr}</div>
      <div style="margin-top: 8px;">
        <button id="fieldAddToCollectionBtn" style="
          background: none; border: 1px solid #9b59b6; border-radius: 4px;
          padding: 4px 10px; cursor: pointer; display: flex; align-items: center; gap: 6px;
          color: #ccc; font-size: 11px; transition: all 0.2s;
        ">
          <img src="icons/ane-collection-icon.svg" style="width:14px;height:14px;">
          Add to Quick Collection
        </button>
      </div>
    `;

    // Wire up the add-to-collection button
    const addBtn = document.getElementById('fieldAddToCollectionBtn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const normalizedPaper = {
          workId: paper.id?.replace('https://openalex.org/', '') || '',
          doi: doi ? doi.replace('https://doi.org/', '') : null,
          title: title,
          year: paper.publication_year || null,
          citationCount: citations,
          authors: (paper.authorships || []).map(a => ({
            name: a.author?.display_name || '',
            id: a.author?.id || ''
          })),
          concepts: (paper.concepts || []).map(c => ({
            name: c.display_name || '',
            id: c.id || ''
          })),
          references: paper.referenced_works || []
        };
        if (typeof addPaperToQuickCollection === 'function') {
          addPaperToQuickCollection(normalizedPaper);
        }
        addBtn.innerHTML = '<span style="color: #22c55e;">Added</span>';
        addBtn.style.borderColor = '#22c55e';
        addBtn.disabled = true;
      });

      addBtn.addEventListener('mouseenter', () => {
        addBtn.style.borderColor = '#4ecca3';
        addBtn.style.color = '#4ecca3';
      });
      addBtn.addEventListener('mouseleave', () => {
        if (!addBtn.disabled) {
          addBtn.style.borderColor = '#9b59b6';
          addBtn.style.color = '#ccc';
        }
      });
    }

    panel.style.display = 'block';
  }

  onNodeDoubleClick(nodeId) {
    // If in cluster view, drill down to show papers in that cluster
    if (this.viewMode === 'clusters' && this.conceptClusters.has(nodeId)) {
      const cluster = this.conceptClusters.get(nodeId);
      // Switch to paper view but filter to this cluster
      // For now, just switch to paper view
      this.setViewMode('papers');

      // Update button styles
      const controls = this.container.querySelector('.field-view-controls');
      if (controls) {
        controls.querySelectorAll('.field-view-btn').forEach(b => {
          const isActive = b.dataset.mode === 'papers';
          b.style.background = isActive ? '#4ecca3' : '#1a1a2e';
          b.style.color = isActive ? '#1a1a2e' : '#888';
          b.style.borderColor = isActive ? '#4ecca3' : '#333';
        });
      }
    }
  }

  runPhysicsAndFit() {
    this.isStabilizing = true;

    this.network.setOptions({
      physics: {
        enabled: true,
        barnesHut: {
          gravitationalConstant: -2000,
          centralGravity: 0.15,
          springLength: 100,
          springConstant: 0.04,
          damping: 0.5,
          avoidOverlap: 0.3
        },
        maxVelocity: 40,
        solver: 'barnesHut',
        stabilization: { enabled: true, iterations: 120, fit: true }
      }
    });

    setTimeout(() => {
      if (this.isStabilizing) {
        this.isStabilizing = false;
        this.network.setOptions({ physics: { enabled: false } });
        this.network.fit({ animation: { duration: 300, easingFunction: 'easeOutQuad' } });
      }
    }, 2500);
  }

  truncate(text, maxLen) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 2) + '..';
  }
}

if (typeof window !== 'undefined') {
  window.FieldTopologyVisualizer = FieldTopologyVisualizer;
}
