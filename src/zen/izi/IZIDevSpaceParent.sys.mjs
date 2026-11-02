// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Parent half of the IZI DevSpace window actor. The chrome code talks to pages
// with `windowGlobal.getActor("IZIDevSpace").sendQuery(...)`; nothing needs to
// be handled here.
export class IZIDevSpaceParent extends JSWindowActorParent {}
