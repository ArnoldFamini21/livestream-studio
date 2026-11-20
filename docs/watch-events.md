# Private viewing and audience call-ins

Create or schedule a studio with **Require a private viewing link** under
**Scheduling & guest access**. Inside the studio, open **Invite** and use
**Create private viewing link**. Share that link with invited viewers. It
expires after seven days. It can be forwarded, so share it with the people
you want to invite. The viewing link never grants access to the studio.

Invited viewers enter their name and email before playing the video. The
playback pass expires after 12 hours or when the invitation expires,
whichever is earlier. It covers the live playlist, video segments, polls
and audience interactions. Registered events that allow anyone to sign up
also enforce registration on video playback. Events with registration
turned off still allow anonymous viewing.

Enable **Allow audience call-ins** under **Invite**. The studio team sees
each request and decides whether to approve it. Approval opens the existing
device check and green room using a one-time link valid for two minutes.
The studio team admits the participant and moves them on stage separately.
Call-ins are off by default and waiting requests expire after five minutes.
The queue resets on a signaling restart.

Private playback uses the studio's existing shared live stream signing
secret. Coordinate the signaling and media relay rollout when enabling
protected playback. Before updating, drain active and reconnecting live
relays or schedule the rollout during a break in broadcasts. Pre-upgrade
relays published registered events with public credentials. Resume normal
broadcasts after both servers are updated. An older media relay omits
protected watch HLS from newly issued credentials because they contain no
public watch identifier.
