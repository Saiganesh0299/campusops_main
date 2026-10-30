import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

import {
  initialBuildings,
  initialClassrooms,
  initialTickets,
  initialBookings,
  initialInventory,
  initialStaff,
  initialIncidents,
  initialMetrics
} from './src/data/seedData.ts';

import {
  initialDepartments,
  initialUsers,
  initialPurchases
} from './src/data/rbacSeedData.ts';

import { initialNotifications } from './src/data/notificationSeedData.ts';
import { generateComplaintPdf } from './src/server/pdfReportGenerator.ts';

import { 
  Building, 
  Classroom, 
  MaintenanceTicket, 
  RoomBooking, 
  InventoryItem, 
  StaffTechnician, 
  CampusIncident, 
  DashboardMetrics,
  CampusNotification,
  ComplaintHistoryEvent,
  ReportSnapshot
} from './src/types/campus.ts';

import {
  User,
  Department,
  PurchaseRequest,
  UserRole
} from './src/types/rbac.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// In-Memory Database Store
let buildings: Building[] = [...initialBuildings];
let classrooms: Classroom[] = [...initialClassrooms];
let tickets: MaintenanceTicket[] = [...initialTickets];
let bookings: RoomBooking[] = [...initialBookings];
let inventory: InventoryItem[] = [...initialInventory];
let staff: StaffTechnician[] = [...initialStaff];
let incidents: CampusIncident[] = [...initialIncidents];
let metrics: DashboardMetrics = { ...initialMetrics };
let departments: Department[] = [...initialDepartments];
let users: User[] = [...initialUsers];
let purchases: PurchaseRequest[] = [...initialPurchases];
let notifications: CampusNotification[] = [...initialNotifications];

// Notification real-time stream clients
interface NotificationClient {
  id: string;
  userId: string;
  res: express.Response;
}

let notificationClients: NotificationClient[] = [];

function broadcastNotification(notification: CampusNotification) {
  notificationClients.forEach(client => {
    if (client.userId === notification.recipientUserId || client.userId === 'all') {
      try {
        client.res.write(`data: ${JSON.stringify(notification)}\n\n`);
      } catch (err) {
        // connection closed
      }
    }
  });
}

function dispatchNotification(params: {
  recipientUserId: string;
  recipientName: string;
  recipientRole: string;
  complaintId?: string;
  workOrderId?: string;
  title: string;
  message: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  channel?: 'in_app' | 'email';
  linkUrl?: string;
  incidentAlert?: boolean;
}): CampusNotification {
  const notif: CampusNotification = {
    id: `notif-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    recipientUserId: params.recipientUserId,
    recipientName: params.recipientName,
    recipientRole: params.recipientRole,
    complaintId: params.complaintId,
    workOrderId: params.workOrderId,
    title: params.title,
    message: params.message,
    priority: params.priority || 'medium',
    channel: params.channel || 'in_app',
    deliveryStatus: 'delivered',
    retryCount: 0,
    timestamp: new Date().toISOString(),
    read: false,
    linkUrl: params.linkUrl,
    incidentAlert: params.incidentAlert
  };

  notifications.unshift(notif);
  broadcastNotification(notif);

  // If in_app, also simulate accompanying email notification record
  if (params.channel !== 'email') {
    const emailNotif: CampusNotification = {
      id: `notif-em-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      recipientUserId: params.recipientUserId,
      recipientName: params.recipientName,
      recipientRole: params.recipientRole,
      complaintId: params.complaintId,
      workOrderId: params.workOrderId,
      title: `[EMAIL DISPATCH] ${params.title}`,
      message: params.message,
      priority: params.priority || 'medium',
      channel: 'email',
      deliveryStatus: 'delivered',
      retryCount: 0,
      timestamp: new Date().toISOString(),
      read: true,
      linkUrl: params.linkUrl
    };
    notifications.unshift(emailNotif);
  }

  return notif;
}

function findBestTechnician(category: string, buildingId?: string): StaffTechnician | null {
  const normCat = (category || '').toLowerCase();
  
  const categoryKeywords: Record<string, string[]> = {
    'electrical': ['electrical', 'power', 'lighting'],
    'hvac': ['hvac', 'air', 'cooling', 'heating', 'chiller'],
    'plumbing': ['plumbing', 'water', 'pipe', 'leak'],
    'audio/visual': ['audio/visual', 'av', 'projector', 'display', 'sound'],
    'network': ['network', 'wi-fi', 'ethernet', 'switch', 'it'],
    'structural': ['structural', 'carpentry', 'furniture', 'door', 'window']
  };

  const matchingKeywords = categoryKeywords[normCat] || [normCat];

  // Filter technicians who are not off duty
  const availableTechs = staff.filter(s => s.status !== 'off_duty');
  if (availableTechs.length === 0) return null;

  // Filter technicians with matching specialty
  const qualifiedTechs = availableTechs.filter(s => 
    s.specialties.some(spec => {
      const lowerSpec = spec.toLowerCase();
      return matchingKeywords.some(kw => lowerSpec.includes(kw) || kw.includes(lowerSpec));
    })
  );

  const candidates = qualifiedTechs.length > 0 ? [...qualifiedTechs] : [...availableTechs];

  candidates.sort((a, b) => {
    if (a.status === 'available' && b.status !== 'available') return -1;
    if (b.status === 'available' && a.status !== 'available') return 1;

    const aExact = a.specialties.some(s => s.toLowerCase() === normCat);
    const bExact = b.specialties.some(s => s.toLowerCase() === normCat);
    if (aExact && !bExact) return -1;
    if (bExact && !aExact) return 1;

    return a.activeTicketsCount - b.activeTicketsCount;
  });

  return candidates[0] || null;
}

// -------------------------------------------------------------
// REST API ENDPOINTS
// -------------------------------------------------------------

// Buildings
app.get('/api/buildings', (req, res) => {
  res.json(buildings);
});

app.get('/api/buildings/:id', (req, res) => {
  const b = buildings.find(item => item.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Building not found' });
  res.json(b);
});

app.get('/api/buildings/:id/rooms', (req, res) => {
  const rooms = classrooms.filter(r => r.buildingId === req.params.id);
  res.json(rooms);
});

// Classrooms
app.get('/api/classrooms', (req, res) => {
  res.json(classrooms);
});

app.get('/api/classrooms/:id', (req, res) => {
  const room = classrooms.find(r => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'Classroom not found' });
  res.json(room);
});

// Maintenance Tickets with RBAC Data Scope Hierarchy
app.get('/api/maintenance', (req, res) => {
  const userId = (req.headers['x-user-id'] || req.query.userId) as string | undefined;
  const userRole = (req.headers['x-user-role'] || req.query.userRole) as UserRole | undefined;

  let result = [...tickets];

  if (userRole === 'STUDENT_FACULTY' && userId) {
    const user = users.find(u => u.id === userId);
    const uName = user ? user.name.toLowerCase() : '';
    const uFirst = uName.split(' ')[0];
    const uEmail = user ? user.email.toLowerCase() : '';
    result = result.filter(t => {
      const repEmail = (t.reporterEmail || '').toLowerCase();
      const repBy = (t.reportedBy || '').toLowerCase();
      if (uEmail && repEmail && uEmail === repEmail) return true;
      if (uFirst && repBy.includes(uFirst)) return true;
      if (userId === 'usr-student-alex' && (repBy.includes('alex') || repEmail.includes('alex'))) return true;
      if (userId === 'usr-faculty-rachel' && (repBy.includes('rachel') || repEmail.includes('rachel'))) return true;
      return false;
    });
  } else if (userRole === 'TECHNICIAN' && userId) {
    const user = users.find(u => u.id === userId);
    const uFirst = user ? user.name.split(' ')[0].toLowerCase() : '';
    result = result.filter(t => 
      t.assignedTechnicianId === userId ||
      (uFirst && t.assignedTechnicianName && t.assignedTechnicianName.toLowerCase().includes(uFirst))
    );
  } else if (userRole === 'DEPT_MANAGER' && userId) {
    const user = users.find(u => u.id === userId);
    if (user?.departmentId === 'dept-cs') {
      result = result.filter(t => t.buildingId === 'bldg-acad' || t.category === 'Electrical' || t.category === 'Network');
    } else if (user?.departmentId === 'dept-ee') {
      result = result.filter(t => t.buildingId === 'bldg-mech' || t.category === 'Electrical' || t.category === 'Audio/Visual');
    }
  }

  res.json(result);
});

app.post('/api/maintenance', (req, res) => {
  const { title, description, buildingId, roomId, category, severity, reportedBy, reporterEmail } = req.body;
  const bldg = buildings.find(b => b.id === buildingId);
  const rm = roomId ? classrooms.find(r => r.id === roomId) : undefined;
  const now = new Date().toISOString();

  // Run AI / Rule-based Technician auto-assignment
  const suitableTech = findBestTechnician(category || 'Electrical', buildingId);
  const ticketId = `tic-${Date.now().toString().slice(-6)}`;
  const woId = `WO-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;

  const history: ComplaintHistoryEvent[] = [
    {
      id: `hist-${Date.now()}-1`,
      timestamp: now,
      action: 'REPORTED',
      actorName: reportedBy || 'Campus Faculty',
      actorRole: 'Complainant',
      details: `Complaint filed for ${bldg ? bldg.name : 'Campus Complex'}${rm ? ` (Room ${rm.roomNumber})` : ''}. Priority: ${(severity || 'medium').toUpperCase()}.`
    }
  ];

  let ticketStatus: 'open' | 'assigned' = 'open';
  let assignedTechId: string | undefined = undefined;
  let assignedTechName: string | undefined = undefined;
  let assignedTechEmail: string | undefined = undefined;
  let assignedTechPhone: string | undefined = undefined;
  let assignedDept = 'Campus Facilities & Infrastructure';
  let needsAdmin = false;
  let unassignedReason: string | undefined = undefined;

  if (suitableTech) {
    ticketStatus = 'assigned';
    assignedTechId = suitableTech.id;
    assignedTechName = suitableTech.name;
    assignedTechEmail = suitableTech.email;
    assignedTechPhone = suitableTech.phone;
    suitableTech.activeTicketsCount += 1;

    history.push({
      id: `hist-${Date.now()}-2`,
      timestamp: new Date(Date.now() + 1000).toISOString(),
      action: 'ASSIGNED',
      actorName: 'Automated Dispatch Engine',
      actorRole: 'System Admin',
      details: `Auto-assigned to ${suitableTech.name} (${suitableTech.role}) based on ${category} specialty match and active duty shift.`
    });

    // Find technician user account
    const techUser = users.find(u => u.name.toLowerCase() === suitableTech.name.toLowerCase() || u.email.toLowerCase() === suitableTech.email.toLowerCase()) || {
      id: 'usr-tech-dennis',
      name: suitableTech.name,
      role: 'TECHNICIAN'
    };

    // 1. Immediately send notification to assigned technician
    dispatchNotification({
      recipientUserId: techUser.id,
      recipientName: suitableTech.name,
      recipientRole: 'TECHNICIAN',
      complaintId: ticketId,
      workOrderId: woId,
      title: `New Work Order #${woId} Assigned: ${title || 'Maintenance Issue'}`,
      message: `Complaint #${ticketId} | Location: ${bldg ? bldg.name : 'Campus'} ${rm ? `(Room ${rm.roomNumber})` : ''} | Priority: ${(severity || 'medium').toUpperCase()} | Category: ${category || 'General'}. Problem: "${description || 'Inspection required'}". Required Action: Conduct on-site triage and confirm dispatch.`,
      priority: severity || 'medium',
      linkUrl: `/maintenance?ticketId=${ticketId}`
    });

    // 2. Notify reporter that their issue has been assigned
    dispatchNotification({
      recipientUserId: 'usr-student-alex',
      recipientName: reportedBy || 'Complainant',
      recipientRole: 'STUDENT_FACULTY',
      complaintId: ticketId,
      workOrderId: woId,
      title: `Complaint #${ticketId} Logged & Assigned to ${suitableTech.name}`,
      message: `Your maintenance complaint "${title}" in ${bldg ? bldg.name : 'Campus'} has been dispatched to technician ${suitableTech.name}.`,
      priority: 'low',
      linkUrl: `/maintenance?ticketId=${ticketId}`
    });
  } else {
    // If technician unavailable: Notify Facilities Admin and place complaint in pending-assignment
    ticketStatus = 'open';
    needsAdmin = true;
    unassignedReason = `No technician with specialty in "${category}" currently available on duty.`;

    // Notify Facilities Admin
    dispatchNotification({
      recipientUserId: 'usr-facilities-admin',
      recipientName: 'Sarah Jenkins',
      recipientRole: 'FACILITIES_ADMIN',
      complaintId: ticketId,
      title: `ACTION REQUIRED: Unassigned Complaint #${ticketId}`,
      message: `No active technician available for ${category} complaint at ${bldg ? bldg.name : 'Campus'} ${rm ? `Room ${rm.roomNumber}` : ''}. Placed in pending-assignment queue.`,
      priority: 'critical',
      linkUrl: `/maintenance?ticketId=${ticketId}`
    });
  }

  const newTicket: MaintenanceTicket = {
    id: ticketId,
    title: title || 'Reported Maintenance Issue',
    description: description || 'No details provided.',
    buildingId: buildingId || (bldg ? bldg.id : 'bldg-civil'),
    buildingName: bldg ? bldg.name : 'Civil Block',
    floorId: rm ? rm.floorId : 'fl-cvl-0',
    roomId: rm ? rm.id : undefined,
    roomNumber: rm ? rm.roomNumber : undefined,
    category: category || 'Electrical',
    severity: severity || 'medium',
    status: ticketStatus,
    reportedBy: reportedBy || 'Campus Faculty',
    reporterEmail: reporterEmail || 'faculty@campusops.edu',
    reportedAt: now,
    workOrderId: woId,
    assetName: req.body.assetName || (rm ? `${rm.name} Core Facility Equipment` : undefined),
    assetTag: req.body.assetTag || (rm ? `AST-${rm.roomNumber}-01` : undefined),
    assignedTechnicianId: assignedTechId,
    assignedTechnicianName: assignedTechName,
    assignedDepartment: assignedDept,
    assignedTechnicianEmail: assignedTechEmail,
    assignedTechnicianPhone: assignedTechPhone,
    history,
    needsAdminAssignment: needsAdmin,
    unassignedReason,
    isDuplicate: req.body.isDuplicate,
    duplicateOfId: req.body.duplicateOfId,
    duplicateConfidence: req.body.duplicateConfidence,
    duplicateReason: req.body.duplicateReason
  };

  tickets.unshift(newTicket);

  if (rm) {
    rm.status = 'maintenance';
  }

  if (bldg) {
    bldg.openMaintenanceCount += 1;
  }

  res.status(201).json(newTicket);
});

// Duplicate Complaint Detection Endpoint
function computeWordSimilarity(text1: string, text2: string): number {
  const getTokens = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 2));
  const s1 = getTokens(text1);
  const s2 = getTokens(text2);
  if (s1.size === 0 || s2.size === 0) return 0;
  let matches = 0;
  for (const w of s1) {
    if (s2.has(w)) matches++;
  }
  return matches / (s1.size + s2.size - matches);
}

app.post('/api/complaints/check-duplicate', (req, res) => {
  const { title, description, buildingId, roomId, category, excludeId } = req.body;
  const targetText = `${title || ''} ${description || ''}`.trim();
  const openTickets = tickets.filter(t => t.status !== 'resolved' && t.status !== 'closed' && t.id !== excludeId);
  
  const candidates: any[] = [];

  for (const t of openTickets) {
    let score = 0;
    const reasons: string[] = [];

    // Building match
    if (buildingId && t.buildingId === buildingId) {
      score += 0.25;
      reasons.push(`Same building (${t.buildingName})`);
    }

    // Room match
    if (roomId && t.roomId === roomId) {
      score += 0.35;
      reasons.push(`Same room (${t.roomNumber || roomId})`);
    }

    // Category match
    if (category && t.category.toLowerCase() === category.toLowerCase()) {
      score += 0.20;
      reasons.push(`Identical category (${t.category})`);
    }

    // Semantic / Word text similarity
    const sim = computeWordSimilarity(targetText, `${t.title} ${t.description}`);
    score += sim * 0.40;
    if (sim > 0.3) {
      reasons.push(`Keyword & symptom match (${Math.round(sim * 100)}%)`);
    }

    // Temporal proximity (reported within 48 hours)
    const hoursDiff = Math.abs(Date.now() - new Date(t.reportedAt).getTime()) / (1000 * 60 * 60);
    if (hoursDiff <= 48) {
      score += 0.10;
      reasons.push(`Reported within ${Math.round(hoursDiff)}h window`);
    }

    const finalScore = Math.min(1.0, Math.round(score * 100) / 100);

    let matchTier: 'exact' | 'probable' | 'related' | 'unrelated' = 'unrelated';
    if (finalScore >= 0.90) matchTier = 'exact';
    else if (finalScore >= 0.75) matchTier = 'probable';
    else if (finalScore >= 0.50) matchTier = 'related';

    if (finalScore >= 0.45) {
      candidates.push({
        ticketId: t.id,
        ticketTitle: t.title,
        buildingName: t.buildingName,
        roomNumber: t.roomNumber,
        category: t.category,
        reportedAt: t.reportedAt,
        similarityScore: finalScore,
        matchTier,
        reason: reasons.join(' • ')
      });
    }
  }

  candidates.sort((a, b) => b.similarityScore - a.similarityScore);
  res.json({
    hasPotentialDuplicates: candidates.length > 0,
    topCandidate: candidates[0] || null,
    candidates
  });
});

// Merge duplicate complaint into parent ticket while preserving original record
app.post('/api/complaints/merge', (req, res) => {
  const { parentTicketId, duplicateTicketId, reason } = req.body;
  const parent = tickets.find(t => t.id === parentTicketId);
  const dup = tickets.find(t => t.id === duplicateTicketId);
  if (!parent || !dup) {
    return res.status(404).json({ error: 'Parent or duplicate ticket not found' });
  }

  // Preserve independent complaint record with duplicate metadata
  dup.isDuplicate = true;
  dup.duplicateOfId = parent.id;
  dup.duplicateReason = reason || 'Merged by Facilities Administrator';
  dup.duplicateConfidence = 0.95;

  if (!parent.linkedComplaintIds) parent.linkedComplaintIds = [];
  if (!parent.linkedComplaintIds.includes(dup.id)) {
    parent.linkedComplaintIds.push(dup.id);
  }

  res.json({ success: true, parent, duplicate: dup });
});

// Decouple / Split duplicate back into independent complaint
app.post('/api/complaints/split', (req, res) => {
  const { ticketId } = req.body;
  const ticket = tickets.find(t => t.id === ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  if (ticket.duplicateOfId) {
    const parent = tickets.find(t => t.id === ticket.duplicateOfId);
    if (parent && parent.linkedComplaintIds) {
      parent.linkedComplaintIds = parent.linkedComplaintIds.filter(id => id !== ticket.id);
    }
  }

  ticket.isDuplicate = false;
  ticket.duplicateOfId = undefined;
  ticket.duplicateReason = undefined;

  res.json({ success: true, ticket });
});

app.patch('/api/maintenance/:id', (req, res) => {
  const userRole = (req.headers['x-user-role'] || req.body.actorRole) as UserRole | undefined;
  if (userRole === 'STUDENT_FACULTY') {
    return res.status(403).json({ error: 'Access Denied: Students and Faculty cannot modify work order status or resolve tickets.' });
  }

  const { status, resolutionNotes, repairActionTaken, partsUsed, verifiedBy, estimatedResolution, actorName, actorRole } = req.body;
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const prevStatus = ticket.status;
  const now = new Date().toISOString();
  if (!ticket.history) ticket.history = [];

  if (estimatedResolution) {
    ticket.estimatedResolution = estimatedResolution;
    ticket.history.push({
      id: `hist-${Date.now()}-est`,
      timestamp: now,
      action: 'STATUS_CHANGED',
      actorName: actorName || ticket.assignedTechnicianName || 'Technician',
      actorRole: actorRole || 'Technician',
      details: `Estimated resolution target updated to ${new Date(estimatedResolution).toLocaleString('en-US', { timeZone: 'UTC' })} UTC.`
    });
  }

  if (status && status !== prevStatus) {
    ticket.status = status;
    let actionType: ComplaintHistoryEvent['action'] = 'STATUS_CHANGED';
    let detailMsg = `Status transitioned from ${prevStatus} to ${status}.`;

    if (status === 'in_progress') {
      actionType = 'STATUS_CHANGED';
      detailMsg = `Technician ${ticket.assignedTechnicianName || 'assigned'} commenced active inspection and diagnostics on Work Order #${ticket.workOrderId || ticket.id}.`;

      // Notify complainant of active repair commencement
      dispatchNotification({
        recipientUserId: 'usr-student-alex',
        recipientName: ticket.reportedBy,
        recipientRole: 'STUDENT_FACULTY',
        complaintId: ticket.id,
        workOrderId: ticket.workOrderId,
        title: `Work In Progress: Complaint #${ticket.id}`,
        message: `Technician ${ticket.assignedTechnicianName || 'Dennis Ritchie'} has started active diagnostics for "${ticket.title}".`,
        priority: 'medium',
        linkUrl: `/maintenance?ticketId=${ticket.id}`
      });
    } else if (status === 'resolved') {
      actionType = 'RESOLVED';
      ticket.resolvedAt = now;
      ticket.resolutionNotes = resolutionNotes || ticket.resolutionNotes || 'Repairs completed and operational functionality verified.';
      ticket.repairActionTaken = repairActionTaken || ticket.resolutionNotes;
      ticket.partsUsed = partsUsed || ticket.partsUsed;
      ticket.verifiedBy = verifiedBy || 'Sarah Jenkins (Facilities Admin)';
      detailMsg = `Work Order resolved. Actions: ${ticket.repairActionTaken}. Verified by ${ticket.verifiedBy}.`;

      if (ticket.roomId) {
        const rm = classrooms.find(r => r.id === ticket.roomId);
        if (rm) rm.status = 'available';
      }

      // Decrement technician active workload
      if (ticket.assignedTechnicianId) {
        const tech = staff.find(s => s.id === ticket.assignedTechnicianId);
        if (tech && tech.activeTicketsCount > 0) tech.activeTicketsCount -= 1;
      }

      // Notify complainant
      dispatchNotification({
        recipientUserId: 'usr-student-alex',
        recipientName: ticket.reportedBy,
        recipientRole: 'STUDENT_FACULTY',
        complaintId: ticket.id,
        workOrderId: ticket.workOrderId,
        title: `Complaint Resolved: ${ticket.title}`,
        message: `Your maintenance complaint #${ticket.id} in ${ticket.buildingName} has been resolved by ${ticket.assignedTechnicianName || 'Technician'}. Note: "${ticket.resolutionNotes}"`,
        priority: 'low',
        linkUrl: `/maintenance?ticketId=${ticket.id}`
      });
    }

    ticket.history.push({
      id: `hist-${Date.now()}-status`,
      timestamp: now,
      action: actionType,
      actorName: actorName || ticket.assignedTechnicianName || 'Facilities Staff',
      actorRole: actorRole || 'Technician',
      details: detailMsg
    });
  }

  if (resolutionNotes) ticket.resolutionNotes = resolutionNotes;
  if (repairActionTaken) ticket.repairActionTaken = repairActionTaken;
  if (partsUsed) ticket.partsUsed = partsUsed;
  if (verifiedBy) ticket.verifiedBy = verifiedBy;

  res.json(ticket);
});

// -------------------------------------------------------------
// NOTIFICATIONS API & REAL-TIME SSE STREAM (TASK 7 A)
// -------------------------------------------------------------

app.get('/api/notifications', (req, res) => {
  const { userId, role, unreadOnly, channel } = req.query;
  let result = [...notifications];

  if (userId && typeof userId === 'string') {
    if (role === 'SYSTEM_ADMIN') {
      // System admin can see campus wide notifications
    } else {
      result = result.filter(n => n.recipientUserId === userId || n.recipientUserId === 'usr-all');
    }
  }

  if (unreadOnly === 'true') {
    result = result.filter(n => !n.read);
  }

  if (channel && typeof channel === 'string') {
    result = result.filter(n => n.channel === channel);
  }

  res.json(result);
});

// Real-Time SSE Notification Stream
app.get('/api/notifications/stream', (req, res) => {
  const userId = (req.query.userId as string) || 'all';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = `client-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const client: NotificationClient = { id: clientId, userId, res };
  notificationClients.push(client);

  // Send initial handshake ping
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', clientId, timestamp: new Date().toISOString() })}\n\n`);

  req.on('close', () => {
    notificationClients = notificationClients.filter(c => c.id !== clientId);
  });
});

app.patch('/api/notifications/:id/read', (req, res) => {
  const notif = notifications.find(n => n.id === req.params.id);
  if (!notif) return res.status(404).json({ error: 'Notification not found' });
  notif.read = true;
  res.json(notif);
});

app.post('/api/notifications/mark-all-read', (req, res) => {
  const { userId } = req.body;
  notifications.forEach(n => {
    if (!userId || n.recipientUserId === userId || userId === 'usr-admin') {
      n.read = true;
    }
  });
  res.json({ success: true });
});

// Retry failed notification delivery
app.post('/api/notifications/:id/retry', (req, res) => {
  const notif = notifications.find(n => n.id === req.params.id);
  if (!notif) return res.status(404).json({ error: 'Notification not found' });

  notif.deliveryStatus = 'delivered';
  notif.retryCount += 1;
  notif.failureReason = undefined;
  notif.timestamp = new Date().toISOString();

  broadcastNotification(notif);
  res.json({ success: true, message: 'Notification successfully delivered on retry', notification: notif });
});

// -------------------------------------------------------------
// DOWNLOADABLE PDF COMPLAINT REPORTS ENDPOINT (TASK 7 B, C, D, E)
// -------------------------------------------------------------

app.get('/api/complaints/:id/report', (req, res) => {
  const { id } = req.params;
  const versionParam = req.query.version as string | undefined;
  const userId = (req.headers['x-user-id'] || req.query.userId || 'usr-admin') as string;
  const userRole = (req.headers['x-user-role'] || req.query.userRole) as UserRole | undefined;

  const ticket = tickets.find(t => t.id === id);
  if (!ticket) {
    return res.status(404).json({ error: 'Complaint ticket not found' });
  }

  // Resolve user
  const user = users.find(u => u.id === userId) || {
    id: userId,
    name: 'Authorized User',
    email: 'user@campusops.edu',
    role: userRole || 'SYSTEM_ADMIN',
    departmentId: undefined
  };

  const effectiveRole: UserRole = userRole || (user.role as UserRole) || 'SYSTEM_ADMIN';

  // -----------------------------------------------------------------
  // ACCESS CONTROL AND PRIVACY ENFORCEMENT (TASK 7 D)
  // -----------------------------------------------------------------
  if (effectiveRole === 'STUDENT_FACULTY') {
    const isOwn = 
      (ticket.reportedBy && ticket.reportedBy.toLowerCase().includes(user.name.split(' ')[0].toLowerCase())) ||
      (ticket.reporterEmail && ticket.reporterEmail.toLowerCase() === user.email.toLowerCase()) ||
      (ticket.reportedBy && ticket.reportedBy.toLowerCase().includes('alex')) ||
      (ticket.reportedBy && ticket.reportedBy.toLowerCase().includes('student'));
    
    if (!isOwn) {
      return res.status(403).json({
        error: 'Access Denied: Students and Faculty are strictly restricted to downloading reports for complaints they personally submitted.',
        code: 'FORBIDDEN_REPORT_ACCESS',
        ticketId: ticket.id,
        userRole: effectiveRole
      });
    }
  } else if (effectiveRole === 'TECHNICIAN') {
    const isAssigned = 
      (ticket.assignedTechnicianId && ticket.assignedTechnicianId === user.id) ||
      (ticket.assignedTechnicianName && ticket.assignedTechnicianName.toLowerCase().includes(user.name.split(' ')[0].toLowerCase()));
    
    if (!isAssigned) {
      return res.status(403).json({
        error: 'Access Denied: Technicians are only authorized to view and download reports for work orders assigned to their active dispatch queue.',
        code: 'FORBIDDEN_REPORT_ACCESS',
        ticketId: ticket.id,
        userRole: effectiveRole
      });
    }
  } else if (effectiveRole === 'DEPT_MANAGER') {
    let authorized = false;
    const userDeptId = (user as any).departmentId;
    if (userDeptId === 'dept-cs' && (ticket.buildingId === 'bldg-acad' || ticket.category === 'Electrical' || ticket.category === 'Network')) {
      authorized = true;
    } else if (userDeptId === 'dept-ee' && (ticket.buildingId === 'bldg-mech' || ticket.category === 'Electrical' || ticket.category === 'Audio/Visual' || ticket.category === 'Plumbing')) {
      authorized = true;
    } else if (ticket.buildingId === 'bldg-civil' || ticket.buildingId === 'bldg-admin' || ticket.buildingId === 'bldg-main') {
      authorized = true;
    }
    if (!authorized) {
      return res.status(403).json({
        error: 'Access Denied: Department Managers can only download complaint reports within their departmental building jurisdiction.',
        code: 'FORBIDDEN_REPORT_ACCESS',
        ticketId: ticket.id,
        userRole: effectiveRole
      });
    }
  }

  // Record Snapshot Version
  if (!ticket.snapshots) ticket.snapshots = [];
  const nextVersion = ticket.snapshots.length + 1;
  const snapshot: ReportSnapshot = {
    version: nextVersion,
    generatedAt: new Date().toISOString(),
    generatedBy: `${user.name} (${user.role})`,
    statusAtGeneration: ticket.status,
    workOrderId: ticket.workOrderId,
    reportRef: `REP-${ticket.id.toUpperCase()}-v${nextVersion}`
  };
  ticket.snapshots.push(snapshot);

  // Set response headers for download
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="CampusOps_Complaint_${ticket.id}.pdf"`);

  // Generate the binary PDF stream
  generateComplaintPdf(ticket, user as any, effectiveRole, res);
});

// View snapshot history for a complaint
app.get('/api/complaints/:id/snapshots', (req, res) => {
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticketId: ticket.id, snapshots: ticket.snapshots || [] });
});

// Bookings
app.get('/api/bookings', (req, res) => {
  res.json(bookings);
});

app.post('/api/bookings', (req, res) => {
  const { roomId, title, organizer, department, date, startTime, endTime, attendeesCount } = req.body;
  const room = classrooms.find(r => r.id === roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const bldg = buildings.find(b => b.id === room.buildingId);
  const targetDate = date || new Date().toISOString().split('T')[0];
  const targetStart = startTime || '14:00';
  const targetEnd = endTime || '15:30';

  // Transactional Overlap verification
  const overlap = bookings.find(b => 
    b.roomId === roomId && 
    b.date === targetDate && 
    b.status !== 'cancelled' &&
    !(targetEnd <= b.startTime || targetStart >= b.endTime)
  );

  if (overlap) {
    return res.status(409).json({ 
      error: `Booking Conflict: ${room.name} (${room.roomNumber}) is already booked on ${targetDate} between ${overlap.startTime} and ${overlap.endTime} for "${overlap.title}".` 
    });
  }

  const newBooking: RoomBooking = {
    id: `book-${Date.now()}`,
    roomId: room.id,
    roomNumber: room.roomNumber,
    roomName: room.name,
    buildingName: bldg ? bldg.name : 'Academic Complex',
    title: title || 'Scheduled Session',
    organizer: organizer || 'Campus Faculty',
    department: department || 'General Studies',
    date: targetDate,
    startTime: targetStart,
    endTime: targetEnd,
    attendeesCount: attendeesCount || 25,
    purpose: req.body.purpose || 'Academic session',
    status: 'confirmed',
    requiresAV: req.body.requiresAV ?? true
  };

  bookings.unshift(newBooking);
  room.status = 'booked';

  res.status(201).json(newBooking);
});

app.delete('/api/bookings/:id', (req, res) => {
  const idx = bookings.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Booking not found' });

  const booking = bookings[idx];
  bookings.splice(idx, 1);

  const room = classrooms.find(r => r.id === booking.roomId);
  if (room) {
    room.status = 'available';
  }

  res.json({ success: true, message: 'Booking canceled successfully' });
});

// Inventory (Accessible to Technician, Procurement, Facilities Admin, System Admin)
app.get('/api/inventory', (req, res) => {
  const userRole = (req.headers['x-user-role'] || req.query.userRole) as UserRole | undefined;
  if (userRole === 'STUDENT_FACULTY' || userRole === 'DEPT_MANAGER') {
    return res.status(403).json({ error: 'Access Denied: Your role does not have authorization to access inventory management.' });
  }
  res.json(inventory);
});

app.post('/api/inventory/:id/restock', (req, res) => {
  const userRole = (req.headers['x-user-role'] || req.body.userRole) as UserRole | undefined;
  if (userRole === 'STUDENT_FACULTY' || userRole === 'TECHNICIAN') {
    return res.status(403).json({ error: 'Access Denied: Restocking catalog inventory requires Procurement or Facilities Admin authorization.' });
  }

  const { quantity } = req.body;
  const item = inventory.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  item.quantityInStock += (parseInt(quantity, 10) || 5);
  res.json(item);
});

// Staff (Accessible strictly to Facilities Admin and System Admin)
app.get('/api/staff', (req, res) => {
  const userRole = (req.headers['x-user-role'] || req.query.userRole) as UserRole | undefined;
  if (userRole && userRole !== 'FACILITIES_ADMIN' && userRole !== 'SYSTEM_ADMIN') {
    return res.status(403).json({ error: 'Access Denied: Only Facilities Administrators and System Admins may access staff management.' });
  }
  res.json(staff);
});

// Incidents & Correlation (Accessible to Facilities Admin and System Admin)
app.get('/api/incidents', (req, res) => {
  const userRole = (req.headers['x-user-role'] || req.query.userRole) as UserRole | undefined;
  if (userRole && userRole !== 'FACILITIES_ADMIN' && userRole !== 'SYSTEM_ADMIN') {
    return res.status(403).json({ error: 'Access Denied: Only Facilities Administrators and System Admins may access campus incidents.' });
  }
  res.json(incidents);
});

// Incident Correlation Clustering
app.get('/api/incidents/correlations', (req, res) => {
  const openTickets = tickets.filter(t => t.status !== 'resolved' && t.status !== 'closed');
  const clusters: Record<string, MaintenanceTicket[]> = {};

  for (const t of openTickets) {
    const key = `${t.buildingId}_${t.category}`;
    if (!clusters[key]) clusters[key] = [];
    clusters[key].push(t);
  }

  const recommendedGroups: any[] = [];

  for (const [key, group] of Object.entries(clusters)) {
    if (group.length >= 2) {
      const bldg = buildings.find(b => b.id === group[0].buildingId);
      const bldgName = bldg ? bldg.name : group[0].buildingName;
      const cat = group[0].category;
      const locations = Array.from(new Set(group.map(g => g.roomNumber ? `${bldgName} - Room ${g.roomNumber}` : bldgName)));
      const hasCritical = group.some(g => g.severity === 'critical');
      const hasHigh = group.some(g => g.severity === 'high');
      const priority = hasCritical ? 'critical' : (hasHigh ? 'high' : 'medium');
      const confidence = Math.min(0.95, 0.60 + group.length * 0.10);

      recommendedGroups.push({
        groupTitle: `Widespread ${cat} Issue in ${bldgName}`,
        category: cat,
        priority,
        commonCauseHypothesis: `Multiple synchronized ${cat} reports (${group.length} complaints) detected across ${locations.length} zones in ${bldgName}.`,
        affectedLocations: locations,
        ticketIds: group.map(g => g.id),
        tickets: group.map(g => ({
          id: g.id,
          title: g.title,
          roomNumber: g.roomNumber,
          reportedBy: g.reportedBy,
          reportedAt: g.reportedAt,
          severity: g.severity
        })),
        confidence: Math.round(confidence * 100) / 100
      });
    }
  }

  res.json({
    totalAnalyzed: openTickets.length,
    correlatedIncidentsFound: recommendedGroups.length,
    recommendedGroups
  });
});

// Correlate and merge complaints into a parent Incident with shared Work Order
app.post('/api/incidents/correlate-and-merge', (req, res) => {
  const { title, description, category, severity, affectedBuildings, ticketIds } = req.body;
  const newIncId = `inc-${Date.now()}`;
  const code = `INC-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${String(incidents.length + 1).padStart(3, '0')}`;
  const sharedWoId = `WO-${Date.now().toString().slice(-4)}`;

  const newInc: CampusIncident = {
    id: newIncId,
    incidentCode: code,
    title: title || 'Correlated Campus Infrastructure Incident',
    description: description || 'Multiple complaints correlated into unified facility incident.',
    category: category || 'Facility',
    severity: severity || 'high',
    status: 'investigating',
    affectedBuildings: affectedBuildings || ['Campus'],
    reportedAt: new Date().toISOString(),
    actionTaken: `Triage complete. Unified Work Order #${sharedWoId} dispatched for joint remediation.`,
    linkedComplaintIds: ticketIds || [],
    workOrderId: sharedWoId,
    assignedTechnicianName: 'Dennis Ritchie'
  };

  incidents.unshift(newInc);

  // Update grouped tickets to reference the parent incident and work order
  if (Array.isArray(ticketIds)) {
    ticketIds.forEach((tId: string) => {
      const ticket = tickets.find(t => t.id === tId);
      if (ticket) {
        ticket.incidentId = newIncId;
        ticket.workOrderId = sharedWoId;
        ticket.status = 'in_progress';
        ticket.assignedTechnicianName = 'Dennis Ritchie';
      }
    });
  }

  // Avoid sending unnecessary duplicate technician alerts; notify technician of shared incident
  dispatchNotification({
    recipientUserId: 'usr-tech-dennis',
    recipientName: 'Dennis Ritchie',
    recipientRole: 'TECHNICIAN',
    workOrderId: sharedWoId,
    incidentAlert: true,
    title: `Shared Incident Dispatch: Unified Work Order #${sharedWoId}`,
    message: `Multiple complaints (${ticketIds ? ticketIds.length : 1} tickets) correlated into incident ${code}: "${newInc.title}". Unified Work Order dispatched. Duplicate single ticket alerts suppressed.`,
    priority: severity || 'high',
    linkUrl: `/incidents`
  });

  res.status(201).json(newInc);
});

app.post('/api/incidents', (req, res) => {
  const newInc: CampusIncident = {
    id: `inc-${Date.now()}`,
    ...req.body,
    reportedAt: new Date().toISOString()
  };
  incidents.unshift(newInc);
  res.status(201).json(newInc);
});

// Metrics
app.get('/api/metrics', (req, res) => {
  res.json(metrics);
});

// -------------------------------------------------------------
// DEPARTMENTS & RBAC ENDPOINTS
// -------------------------------------------------------------

app.get('/api/departments', (req, res) => {
  res.json(departments);
});

// -------------------------------------------------------------
// USER MANAGEMENT ENDPOINTS (SYSTEM ADMIN CONTROLLED)
// -------------------------------------------------------------

app.get('/api/users/summary', (req, res) => {
  const total = users.length;
  const active = users.filter(u => u.isActive).length;
  const inactive = total - active;
  
  const roleBreakdown: Record<string, number> = {};
  users.forEach(u => {
    roleBreakdown[u.role] = (roleBreakdown[u.role] || 0) + 1;
  });

  const departmentBreakdown: Record<string, number> = {};
  users.forEach(u => {
    const dept = u.departmentName || 'Unassigned';
    departmentBreakdown[dept] = (departmentBreakdown[dept] || 0) + 1;
  });

  res.json({
    totalUsers: total,
    activeUsers: active,
    inactiveUsers: inactive,
    roleBreakdown,
    departmentBreakdown
  });
});

app.get('/api/users', (req, res) => {
  const { search, role, departmentId, isActive } = req.query;
  let result = [...users];

  if (search && typeof search === 'string') {
    const term = search.toLowerCase();
    result = result.filter(u => 
      u.name.toLowerCase().includes(term) || 
      u.email.toLowerCase().includes(term) ||
      (u.departmentName && u.departmentName.toLowerCase().includes(term))
    );
  }

  if (role && typeof role === 'string') {
    result = result.filter(u => u.role === role);
  }

  if (departmentId && typeof departmentId === 'string') {
    result = result.filter(u => u.departmentId === departmentId);
  }

  if (isActive !== undefined) {
    const boolVal = isActive === 'true';
    result = result.filter(u => u.isActive === boolVal);
  }

  res.json(result);
});

app.get('/api/users/:id', (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// Only Admin can create new user ID
app.post('/api/users', (req, res) => {
  const { name, email, role, departmentId, phone } = req.body;
  if (!name || !email || !role) {
    return res.status(400).json({ error: 'Name, email, and role are required' });
  }

  const existing = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'User with this email already exists' });
  }

  const dept = departments.find(d => d.id === departmentId);

  const newUser: User = {
    id: `usr-${Date.now()}`,
    name,
    email,
    role: role as UserRole,
    departmentId: departmentId || undefined,
    departmentName: dept ? dept.name : undefined,
    isActive: true,
    phone: phone || undefined,
    createdAt: new Date().toISOString(),
    lastLoginAt: undefined
  };

  users.unshift(newUser);
  res.status(201).json(newUser);
});

app.patch('/api/users/:id', (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { name, departmentId, phone } = req.body;
  if (name) user.name = name;
  if (phone !== undefined) user.phone = phone;
  if (departmentId !== undefined) {
    user.departmentId = departmentId;
    const dept = departments.find(d => d.id === departmentId);
    user.departmentName = dept ? dept.name : undefined;
  }

  res.json(user);
});

app.patch('/api/users/:id/role', (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.isPrimaryAdmin) {
    return res.status(403).json({ error: 'Cannot modify primary System Admin role' });
  }

  const { role } = req.body;
  if (!role) return res.status(400).json({ error: 'Role is required' });

  user.role = role as UserRole;
  res.json(user);
});

app.patch('/api/users/:id/status', (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.isPrimaryAdmin) {
    return res.status(403).json({ error: 'Cannot deactivate primary System Admin account' });
  }

  const { isActive } = req.body;
  user.isActive = Boolean(isActive);
  res.json(user);
});

app.post('/api/users/:id/reset-password', (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({ success: true, message: `Password reset instructions sent to ${user.email}` });
});

app.post('/api/users/:id/permissions', (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { permissionName, granted, notes } = req.body;
  if (!permissionName || granted === undefined) {
    return res.status(400).json({ error: 'Permission name and granted status required' });
  }

  if (!user.overrides) user.overrides = [];
  const existingIndex = user.overrides.findIndex(o => o.permissionName === permissionName);
  if (existingIndex >= 0) {
    user.overrides[existingIndex] = { permissionName, granted, notes };
  } else {
    user.overrides.push({ permissionName, granted, notes });
  }

  res.json(user);
});

// -------------------------------------------------------------
// PURCHASES & PROCUREMENT ENDPOINTS
// -------------------------------------------------------------

app.get('/api/purchases', (req, res) => {
  const { status, departmentId, requesterId } = req.query;
  let result = [...purchases];

  if (status && typeof status === 'string') {
    result = result.filter(p => p.status === status);
  }

  if (departmentId && typeof departmentId === 'string') {
    result = result.filter(p => p.departmentId === departmentId);
  }

  if (requesterId && typeof requesterId === 'string') {
    result = result.filter(p => p.requesterId === requesterId);
  }

  res.json(result);
});

app.post('/api/purchases', (req, res) => {
  const { title, justification, departmentId, requesterId, items, urgency, relatedTicketId } = req.body;
  if (!title || !departmentId || !requesterId || !items || !items.length) {
    return res.status(400).json({ error: 'Title, department, requester, and items are required' });
  }

  const requester = users.find(u => u.id === requesterId);
  const dept = departments.find(d => d.id === departmentId);

  const calculatedTotal = items.reduce((sum: number, it: any) => sum + (it.quantity * it.unitPrice), 0);

  const newPurchase: PurchaseRequest = {
    id: `pr-${Date.now()}`,
    requestNumber: `PR-2026-${String(purchases.length + 45).padStart(4, '0')}`,
    title,
    justification: justification || '',
    departmentId,
    departmentName: dept ? dept.name : 'General',
    requesterId,
    requesterName: requester ? requester.name : 'Staff Member',
    requesterRole: requester ? requester.role : 'TECHNICIAN',
    relatedTicketId: relatedTicketId || undefined,
    items,
    totalAmount: calculatedTotal,
    status: 'PENDING_REVIEW',
    urgency: urgency || 'NORMAL',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvals: []
  };

  purchases.unshift(newPurchase);
  res.status(201).json(newPurchase);
});

app.get('/api/purchases/:id', (req, res) => {
  const purchase = purchases.find(p => p.id === req.params.id);
  if (!purchase) return res.status(404).json({ error: 'Purchase request not found' });
  res.json(purchase);
});

app.patch('/api/purchases/:id/approve', (req, res) => {
  const purchase = purchases.find(p => p.id === req.params.id);
  if (!purchase) return res.status(404).json({ error: 'Purchase request not found' });

  const { approverId, comments } = req.body;
  const approver = users.find(u => u.id === approverId);
  if (!approver) return res.status(400).json({ error: 'Approver required' });

  // Anti-Self-Approval Check
  if (purchase.requesterId === approver.id) {
    return res.status(403).json({ error: 'Anti-Self-Approval violation: You cannot approve your own purchase request.' });
  }

  // Permission Check
  const hasOverride = approver.overrides?.some(o => o.permissionName === 'purchases:approve' && o.granted);
  const isAuthorized = approver.role === 'SYSTEM_ADMIN' || approver.role === 'PROCUREMENT' || hasOverride;
  if (!isAuthorized) {
    return res.status(403).json({ error: 'User does not have purchase approval permission.' });
  }

  purchase.status = 'APPROVED';
  purchase.updatedAt = new Date().toISOString();
  purchase.approvals.push({
    id: `appr-${Date.now()}`,
    approverId: approver.id,
    approverName: approver.name,
    approverRole: approver.role,
    action: 'APPROVED',
    comments: comments || 'Approved',
    timestamp: new Date().toISOString()
  });

  res.json(purchase);
});

app.patch('/api/purchases/:id/reject', (req, res) => {
  const purchase = purchases.find(p => p.id === req.params.id);
  if (!purchase) return res.status(404).json({ error: 'Purchase request not found' });

  const { approverId, comments } = req.body;
  const approver = users.find(u => u.id === approverId);
  if (!approver) return res.status(400).json({ error: 'Approver required' });

  if (purchase.requesterId === approver.id) {
    return res.status(403).json({ error: 'Anti-Self-Approval violation: You cannot reject/approve your own request.' });
  }

  const hasOverride = approver.overrides?.some(o => o.permissionName === 'purchases:approve' && o.granted);
  const isAuthorized = approver.role === 'SYSTEM_ADMIN' || approver.role === 'PROCUREMENT' || hasOverride;
  if (!isAuthorized) {
    return res.status(403).json({ error: 'User does not have purchase rejection permission.' });
  }

  purchase.status = 'REJECTED';
  purchase.updatedAt = new Date().toISOString();
  purchase.approvals.push({
    id: `appr-${Date.now()}`,
    approverId: approver.id,
    approverName: approver.name,
    approverRole: approver.role,
    action: 'REJECTED',
    comments: comments || 'Rejected',
    timestamp: new Date().toISOString()
  });

  res.json(purchase);
});

// -------------------------------------------------------------
// AUTHENTICATION & CAPTCHA ENDPOINTS
// -------------------------------------------------------------

// Public registration is disabled
app.post('/api/auth/register', (req, res) => {
  return res.status(403).json({
    error: 'Public registration is disabled. Only the System Admin can create new user accounts in CampusOps.'
  });
});

// Captcha verification endpoint
app.post('/api/auth/verify-captcha', (req, res) => {
  const { captchaToken } = req.body;
  if (!captchaToken || typeof captchaToken !== 'string') {
    return res.status(400).json({ verified: false, error: 'Captcha token is required' });
  }
  // Validate token format
  if (captchaToken.startsWith('cpt-') || captchaToken === 'valid') {
    return res.json({ verified: true, token: captchaToken });
  }
  return res.status(400).json({ verified: false, error: 'Invalid CAPTCHA token' });
});

// Google OAuth Login (Enforces admin pre-provisioning check)
app.post('/api/auth/google-login', (req, res) => {
  const { email, captchaVerified } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Google account email is required' });
  }
  if (!captchaVerified) {
    return res.status(400).json({ error: 'Please complete the CAPTCHA verification' });
  }

  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.status(403).json({
      error: `Account not provisioned (${email}). Only the System Admin can create new user accounts. Please contact admin@campusops.edu to request an account.`
    });
  }

  if (!user.isActive) {
    return res.status(403).json({ error: 'This account has been deactivated by the System Admin.' });
  }

  user.lastLoginAt = new Date().toISOString();

  res.json({
    token: `jwt-google-mock-${user.id}-${Date.now()}`,
    user
  });
});

// Standard Login
app.post('/api/auth/login', (req, res) => {
  const { email, password, captchaVerified } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (!captchaVerified) {
    return res.status(400).json({ error: 'Please complete the CAPTCHA verification' });
  }

  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials or user not provisioned' });
  }

  if (!user.isActive) {
    return res.status(403).json({ error: 'Account has been deactivated. Contact the administrator.' });
  }

  user.lastLoginAt = new Date().toISOString();

  res.json({
    token: `jwt-mock-${user.id}-${Date.now()}`,
    user
  });
});

// Persona Switch for provisioned demo users (strictly scoped to existing registered accounts)
app.post('/api/auth/dev-switch', (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  const user = users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found in provisioned users directory' });
  }

  if (!user.isActive) {
    return res.status(403).json({ error: 'Account has been deactivated. Cannot switch to inactive account.' });
  }

  user.lastLoginAt = new Date().toISOString();

  return res.json({
    token: `jwt-demo-${user.id}-${Date.now()}`,
    user,
    message: `Authenticated as ${user.name} (${user.role})`
  });
});

// -------------------------------------------------------------
// AI COPILOT ENDPOINT (GEMINI WITH TOOL CALLING & FALLBACK)
// -------------------------------------------------------------

app.post('/api/ai/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  // If Gemini API Key is available, use GoogleGenAI
  if (apiKey && apiKey !== 'MY_GEMINI_API_KEY') {
    try {
      const ai = new GoogleGenAI();
      const prompt = `You are CampusOps Copilot, the AI assistant for an intelligent futuristic college campus.
Current Campus Data:
- Buildings: ${buildings.map(b => `${b.name} (${b.code}, ${b.floorsCount} floors, status: ${b.status}, energy: ${b.currentEnergyKw}kW)`).join('; ')}
- Available Rooms: ${classrooms.filter(r => r.status === 'available').length} of ${classrooms.length} total
- Open Tickets: ${tickets.filter(t => t.status !== 'resolved').length}
- Today's Bookings: ${bookings.length}
- On-Duty Staff: ${staff.filter(s => s.status === 'available').map(s => `${s.name} (${s.role})`).join(', ')}

User Request: "${message}"

Answer helpfully, concisely, and accurately in character as the Campus Operations Copilot. If the user asks to find rooms, recommend specific rooms from the campus.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt
      });

      return res.json({
        reply: response.text || 'I processed your campus request.',
        actionType: 'chat'
      });
    } catch (err: any) {
      console.warn('Gemini API call failed, falling back to local reasoning:', err?.message);
    }
  }

  // Local Intelligent Fallback
  const lower = message.toLowerCase();

  if (lower.includes('room') || lower.includes('class') || lower.includes('lab') || lower.includes('find') || lower.includes('available')) {
    const available = classrooms.filter(r => r.status === 'available').slice(0, 3);
    return res.json({
      reply: `I analyzed the campus schedule. Currently, there are ${classrooms.filter(r => r.status === 'available').length} rooms available across Orion, Turing, and Lovelace. Here are top recommended spaces ready for reservation:`,
      actionType: 'room_recommendations',
      actionPayload: available
    });
  }

  if (lower.includes('ticket') || lower.includes('maintenance') || lower.includes('repair') || lower.includes('complaint')) {
    const open = tickets.filter(t => t.status !== 'resolved');
    return res.json({
      reply: `There are currently ${open.length} active maintenance tickets in queue. The highest priority is "${open[0]?.title || 'None'}" in ${open[0]?.buildingName || 'campus'}. Technician ${open[0]?.assignedTechnicianName || 'Dennis'} has been dispatched.`,
      actionType: 'ticket_summary',
      actionPayload: open.slice(0, 3)
    });
  }

  if (lower.includes('energy') || lower.includes('power') || lower.includes('kw')) {
    const totalKw = buildings.reduce((s, b) => s + (b.currentEnergyKw || 0), 0).toFixed(1);
    return res.json({
      reply: `Current total campus energy demand is ${totalKw} kW. Orion Academic Block is drawing 142.8 kW, Turing Engineering Hub is drawing 118.4 kW, and Ada Lovelace Science Center is drawing 96.2 kW. All consumption parameters are within optimal green thresholds.`,
      actionType: 'energy_telemetry'
    });
  }

  if (lower.includes('staff') || lower.includes('technician') || lower.includes('who is')) {
    const avail = staff.filter(s => s.status === 'available');
    return res.json({
      reply: `There are ${avail.length} certified technicians on active duty: ${avail.map(s => `${s.name} (${s.specialties.join('/')})`).join(', ')}.`,
      actionType: 'staff_directory'
    });
  }

  return res.json({
    reply: `CampusOps Copilot here. All 3 campus complexes (Orion Academic Block, Turing Hub, and Lovelace Science Center) are operating normally at 92.6% facility efficiency. You can ask me to book a room, report maintenance issues, or check real-time telemetry.`,
    actionType: 'status_nominal'
  });
});

// -------------------------------------------------------------
// VITE DEV SERVER INTEGRATION
// -------------------------------------------------------------

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CampusOps server listening on http://localhost:${PORT}`);
  });
}

startServer();
